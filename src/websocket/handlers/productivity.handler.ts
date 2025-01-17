import { WebSocket } from 'ws';
import { Pool } from 'pg';
import { ConnectedClient } from '../../types/websocket.types';
import { MoondreamService } from '../../services/moondream.service';

interface ProductivitySettings {
  tracking_enabled: boolean;
  screen_capture_enabled: boolean;
  webcam_capture_enabled: boolean;
  break_reminder_interval: number;
}

const moondreamService = new MoondreamService();

export const handleUpdateProductivitySettings = async (
  ws: WebSocket,
  parsedMessage: { settings: ProductivitySettings; userId: number },
  pool: Pool
) => {
  try {
    const { settings, userId } = parsedMessage;
    
    // Update or insert settings
    await pool.query(
      `INSERT INTO user_productivity_settings 
       (user_id, tracking_enabled, screen_capture_enabled, webcam_capture_enabled, break_reminder_interval)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         tracking_enabled = $2,
         screen_capture_enabled = $3,
         webcam_capture_enabled = $4,
         break_reminder_interval = $5,
         updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        settings.tracking_enabled,
        settings.screen_capture_enabled,
        settings.webcam_capture_enabled,
        settings.break_reminder_interval
      ]
    );

    // Send confirmation
    ws.send(JSON.stringify({
      type: 'settings_updated',
      success: true
    }));
  } catch (error) {
    console.error('Error updating productivity settings:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to update productivity settings'
    }));
  }
};

export const handleProductivityScreenshot = async (
  ws: WebSocket,
  parsedMessage: any,
  pool: Pool,
  connectedClients: Map<number, ConnectedClient>
) => {
  try {
    console.log('Received productivity message:', {
      type: parsedMessage.type,
      userId: parsedMessage.userId,
      hasData: !!parsedMessage.data,
      dataKeys: parsedMessage.data ? Object.keys(parsedMessage.data) : [],
      screenImageLength: parsedMessage.data?.screen_image?.length,
      fullMessage: JSON.stringify(parsedMessage, (key, value) => {
        if (key === 'screen_image' && typeof value === 'string') {
          return `[base64 string length: ${value.length}]`;
        }
        return value;
      }, 2)
    });

    const userId = parsedMessage.userId;
    const base64Image = parsedMessage.data?.screen_image;

    if (!base64Image) {
      console.error('No screen image provided in message');
      ws.send(JSON.stringify({
        type: 'error',
        message: 'No screen image provided'
      }));
      return;
    }

    // Check if user has productivity tracking enabled
    const settingsResult = await pool.query(
      'SELECT * FROM user_productivity_settings WHERE user_id = $1',
      [userId]
    );

    if (!settingsResult.rows[0]?.tracking_enabled) {
      console.log('Productivity tracking is not enabled for user:', userId);
      return;
    }

    // Analyze the image with Moondream
    console.log('Analyzing productivity for user:', userId);
    const isWorking = await moondreamService.analyzeProductivity(base64Image, userId.toString(), parsedMessage.data.type);
    console.log('Productivity analysis result:', isWorking ? 'WORKING' : 'NOT WORKING');

    // Update or create productivity session
    const now = new Date();
    
    // First try to update an existing active session
    const updateResult = await pool.query(
      `UPDATE productivity_sessions 
       SET last_check_time = $2, is_productive = $3
       WHERE user_id = $1 AND end_time IS NULL
       RETURNING *`,
      [userId, now, isWorking]
    );

    // If no existing session was updated, create a new one
    if (updateResult.rowCount === 0) {
      await pool.query(
        `INSERT INTO productivity_sessions 
         (user_id, start_time, last_check_time, is_productive)
         VALUES ($1, $2, $2, $3)`,
        [userId, now, isWorking]
      );
    }

    // Update user presence
    const presenceStatus = isWorking ? 'productive_working' : 'idle_and_not_working';
    await pool.query(
      'UPDATE users SET presence_status = $1 WHERE id = $2',
      [presenceStatus, userId]
    );

    // Broadcast presence update to all clients
    const presenceMessage = JSON.stringify({
      type: 'presence_update',
      userId,
      status: presenceStatus
    });

    for (const client of connectedClients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(presenceMessage);
      }
    }

    // If not working, send reminder to the user
    if (!isWorking) {
      const reminderMessage = JSON.stringify({
        type: 'productivity_reminder',
        message: 'Time to get back to work!'
      });

      ws.send(reminderMessage);
    }

    // Check for break reminder
    const session = updateResult.rows[0];
    if (session && isWorking) {
      const sessionStart = new Date(session.start_time);
      const workingDuration = (now.getTime() - sessionStart.getTime()) / 1000; // in seconds
      
      if (workingDuration >= settingsResult.rows[0].break_reminder_interval) {
        const breakMessage = JSON.stringify({
          type: 'break_reminder',
          message: 'Time for a short break! You\'ve been working for a while.'
        });
        
        ws.send(breakMessage);

        // Reset the session start time after sending a break reminder
        await pool.query(
          `UPDATE productivity_sessions 
           SET start_time = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [session.id]
        );
      }
    }
  } catch (error) {
    console.error('Error handling productivity screenshot:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to process productivity tracking'
    }));
  }
}; 
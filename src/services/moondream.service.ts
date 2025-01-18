import { OpenAI } from 'openai';
import { config } from '../config/config';
import fs from 'fs';
import path from 'path';

export class MoondreamService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      baseURL: 'https://api.moondream.ai/v1',
      apiKey: config.moondream.apiKey,
    });
  }

  async analyzeProductivity(base64Image: string, userId: string, type: string): Promise<boolean> {
    if (!base64Image) {
      console.error('No base64Image provided to analyzeProductivity');
      throw new Error('base64Image is required');
    }

    console.log('Starting productivity analysis for user:', userId);

    let prompt = '';
    switch (type) {
      case 'screen':
        prompt += 'If you see an IDE, any code or programming, a code editor, documentation, Cursor, a chat window, '
        prompt += 'or "ChatGenius", say "yes". If you see social media, YouTube, any videos, or other '
        prompt += 'related activities, say "no".';
        break;
      case 'webcam':
        prompt += 'Is the person looking at the camera?';
        break;
      default:
        console.error('Invalid type provided to analyzeProductivity:', type);
        throw new Error('Invalid type');
    }
    
    try {
      // Clean the base64 data - remove data URL prefix if present
      const cleanBase64 = base64Image.includes('base64,') 
        ? base64Image.split('base64,')[1]
        : base64Image;

      console.log('Sending request to Moondream API');
      console.log('Clean base64 length:', cleanBase64.length);

      const response = await this.client.chat.completions.create({
        model: 'moondream-2B',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${cleanBase64}` }
              },
              {
                type: 'text',
                text: prompt
              }
            ]
          }
        ],
      });

      const result = response.choices[0]?.message?.content?.toLowerCase() ?? 'not working';

      if (type === 'webcam') {
        return result.toLocaleLowerCase().includes('yes') ? true : false;
      } else {
        return result.toLocaleLowerCase().includes('yes') ? true : false;
      }
    } catch (error) {
      console.error('Error analyzing productivity with Moondream:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          stack: error.stack,
          name: error.name
        });
      }
      // For now, assume the user is working if we can't analyze the image
      return true;
    }
  }
} 
import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import pg from 'pg';
import dotenv from 'dotenv';
import { authorize } from '../middleware/auth.middleware';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class FileController {
    private s3Client: S3Client;

    constructor(
        private app: HyperExpress.Server, 
        private pool: pg.Pool,
    ) {
        dotenv.config();
        this.s3Client = new S3Client({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string
            }
        });
        this.pool = pool;
        
        this.registerRoutes();
    }

    private registerRoutes() {
        this.app.post('/api/upload/request-url', authorize(['admin', 'member']), this.getUploadUrl.bind(this));
        this.app.get('/api/files/uploads/:filename(*)', authorize(['admin', 'member']), this.getDownloadUrl.bind(this));
    }

    private async getUploadUrl(req: Request, res: Response) {
        try {
            const { filename, contentType, size } = await req.json();
            
            // Generate unique storage path
            const storagePath = `uploads/${Date.now()}-${filename}`;
            
            // Create command for generating pre-signed URL
            const command = new PutObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: storagePath,
                ContentType: contentType
            });
    
            // Generate pre-signed URL
            const signedUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    
            res.json({
                uploadUrl: signedUrl,
                storagePath: storagePath
            });
        } catch (error: any) {
            console.error('Upload URL generation error:', error);
            res.status(500).json({ error: error.message });
        }
    }

    private async getDownloadUrl(req: Request, res: Response) {
        try {   
            const filename = req.params['filename(*)'];
    
            // Get file info from database - look up by storage path instead of filename
            const fileResult = await this.pool.query(
                'SELECT * FROM file_attachments WHERE storage_path LIKE $1',
                [`%${filename}`]
            );
            
            if (fileResult.rows.length === 0) {
                return res.status(404).json({ error: 'File not found in database' });
            }
    
            const file = fileResult.rows[0];
            
            // Create command for generating download URL
            const command = new GetObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: file.storage_path
            });
    
            // Generate pre-signed URL for downloading
            const signedUrl = await getSignedUrl(this.s3Client, command, { 
                expiresIn: file.is_image ? 24 * 3600 : 300 // 24 hours for images, 5 minutes for other files
            });
    
            res.json({ 
                downloadUrl: signedUrl,
                filename: file.filename,
                isImage: file.is_image,
                mimeType: file.mime_type,
                size: file.size
            });
        } catch (error: any) {
            console.error('Download URL generation error:', error);
            res.status(500).json({ error: error.message });
        }
    }
} 
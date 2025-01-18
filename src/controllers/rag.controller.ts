import { Request, Response } from 'hyper-express';
import HyperExpress from 'hyper-express';
import { RAGFusion } from '../services/rag-fusion.service';
import { authorize } from '../middleware/auth.middleware';
import pg from 'pg';

interface RequestWithUser extends Request {
  user?: {
    id: string;
    name: string;
  };
}

export class RAGController {
  private ragService: RAGFusion;

  constructor(private app: HyperExpress.Server, private pool: pg.Pool) {
    this.ragService = RAGFusion.getInstance(pool);
    this.registerRoutes();
  }

  private registerRoutes() {
    this.app.post('/api/rag/search', authorize(['admin']), this.search.bind(this));
    this.app.post('/api/rag/documents', authorize(['admin']), this.addDocuments.bind(this));
  }

  private async search(req: RequestWithUser, res: Response): Promise<void> {
    try {
      const { query } = await req.json();
      const userId = req.user?.id;

      if (!query) {
        res.status(400).json({ error: 'Query is required' });
        return;
      }

      const results = await this.ragService.searchWithHypothetical(query, userId);
      res.json({ results });
    } catch (error) {
      console.error('Error in RAG search:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private async addDocuments(req: RequestWithUser, res: Response): Promise<void> {
    try {
      const { documents } = await req.json();
      const userId = Number(req.user?.id);

      if (!userId) {
        res.status(401).json({ error: 'User authentication required' });
        return;
      }

      await this.ragService.addDocuments(documents, userId);
      res.json({ message: 'Documents added successfully' });
    } catch (error: any) {
      console.error('Error adding documents:', error);
      if (error.message.includes('required')) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
} 
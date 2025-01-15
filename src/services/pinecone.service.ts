import { Pinecone } from '@pinecone-database/pinecone';
import { config } from '../config/config';
import { PineconeDocument, PineconeSearchResult, PineconeService } from '../types/rag.types';

export class PineconeClient {
  private client: Pinecone;
  private readonly services: Record<string, PineconeService>;

  constructor() {
    this.client = new Pinecone({
      apiKey: config.pinecone.apiKey,
    });

    this.services = {
      primary: { index: config.pinecone.indexName }
    };
  }

  private getIndex(serviceName: 'primary' | 'secondary') {
    const service = this.services[serviceName];
    return this.client.index(service.index);
  }

  async vectorSearch(
    embeddings: number[],
    serviceName: 'primary' | 'secondary',
    topK: number = 5,
    userId?: string
  ): Promise<PineconeSearchResult[]> {
    try {
      const index = this.getIndex(serviceName);
      const filter = userId ? { userId } : undefined;
      
      const queryResponse = await index.query({
        vector: embeddings,
        topK,
        includeMetadata: true,
        includeValues: true,
        filter
      });

      return queryResponse.matches.map(match => ({
        id: match.id,
        score: match.score ?? 0,
        content: String(match.metadata?.text || ''),
        metadata: match.metadata || {},
      }));
    } catch (error) {
      console.error(`Error in vectorSearch (${serviceName}):`, error);
      throw error;
    }
  }

  async upsertVectors(
    documents: PineconeDocument[],
    serviceName: 'primary' | 'secondary'
  ): Promise<void> {
    try {
      const index = this.getIndex(serviceName);
      
      await index.upsert(
        documents.map(doc => ({
          id: doc.id,
          values: doc.values,
          metadata: doc.metadata,
        }))
      );
    } catch (error) {
      console.error(`Error in upsertVectors (${serviceName}):`, error);
      throw error;
    }
  }

  async getLastNMessagesForUser(userId: string, n: number): Promise<PineconeSearchResult[]> {
    try {
      const index = this.getIndex('primary');
      
      // Create a dummy vector of the right size (1536 for text-embedding-3-large)
      const dummyVector = new Array(1536).fill(0);
      
      const queryResponse = await index.query({
        vector: dummyVector,
        topK: n,
        includeMetadata: true,
        filter: { 
          userId,
          type: 'chat_message'  // Only get actual chat messages
        },
      });
      
      return queryResponse.matches.map(match => ({
        id: match.id,
        score: match.score ?? 0,
        content: String(match.metadata?.text || ''),
        metadata: match.metadata || {},
      }));
    } catch (error) {
      console.error('Error in getLastNMessagesForUser:', error);
      throw error;
    }
  }
} 
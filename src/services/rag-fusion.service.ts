import axios from 'axios';
import { config } from '../config/config';
import { SearchResult } from '../types/rag.types';
import { PineconeClient } from './pinecone.service';
import { OpenAIEmbeddings } from "@langchain/openai";
import OpenAI from 'openai';
import pg from 'pg';

export class RAGFusion {
  private readonly openaiApiKey: string;
  private readonly model: string;
  private readonly pinecone: PineconeClient;
  private static instance: RAGFusion;
  private readonly pool: pg.Pool;

  private constructor(pool: pg.Pool) {
    this.openaiApiKey = config.openai.apiKey;
    this.model = config.openai.model;
    this.pinecone = new PineconeClient();
    this.pool = pool;
  }

  public static getInstance(pool?: pg.Pool): RAGFusion {
    if (!RAGFusion.instance) {
      if (!pool) {
        throw new Error('Pool must be provided when initializing RAGFusion');
      }
      RAGFusion.instance = new RAGFusion(pool);
    }
    return RAGFusion.instance;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const client = new OpenAI({
        apiKey: this.openaiApiKey
      });

      const response = await client.embeddings.create({
        input: text,
        model: 'text-embedding-3-large'
      });


      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  async searchWithQuery(query: string, userId?: string): Promise<SearchResult[]> {
    try {
      const queryEmbedding = await this.generateEmbedding(query);
      
      const results = await this.pinecone.vectorSearch(queryEmbedding, 'primary', 5, userId);
      
      return results;
    } catch (error) {
      console.error('Error in searchWithQuery:', error);
      throw error;
    }
  }

  async generateHypotheticalQuestions(query: string): Promise<string[]> {
    try {
      const client = new OpenAI({
        apiKey: this.openaiApiKey
      });

      const response = await client.chat.completions.create({
        model: this.model,
        messages: [{
          role: 'user',
          content: `Generate 3 hypothetical questions that are relevant to understanding: "${query}". 
                   Return only the questions, one per line, no numbering or prefixes.`
        }],
        temperature: 0.7
      });

      const content = response.choices[0].message.content;
      return content ? content.split('\n').filter((q: string) => q.trim().length > 0) : [];
    } catch (error) {
      console.error('Error generating questions:', error);
      throw error;
    }
  }

  async searchWithHypothetical(query: string, userId?: string): Promise<SearchResult[]> {
    try {
      const questions = await this.generateHypotheticalQuestions(query);
      const searchPromises = [query, ...questions].map(q => 
        this.searchWithQuery(q, userId)
      );

      const allResults = await Promise.all(searchPromises);
      const fusedResults = this.reciprocalRankFusion(allResults);

      return fusedResults;
    } catch (error) {
      console.error('Error in searchWithHypothetical:', error);
      throw error;
    }
  }

  async addDocuments(documents: string[], userId: number): Promise<void> {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error('Documents array is required and cannot be empty');
    }

    if (!userId) {
      throw new Error('User ID is required');
    }

    try {
      const embeddings = new OpenAIEmbeddings();
      
      const vectors = await Promise.all(documents.map(async (doc, i) => {
        const embedding = await this.generateEmbedding(doc);
        return {
          id: `${userId}-${i}`,
          values: embedding,
          metadata: { 
            text: doc,
            userId: userId,
            timestamp: new Date().toISOString()
          }
        };
      }));
      
      await this.pinecone.upsertVectors(vectors, 'primary');
    } catch (error) {
      console.error('Error adding documents:', error);
      throw error;
    }
  }

  async addChatMessage(
    message: {
      id: string;
      content: string;
      userId: string;
      channelId: string;
      threadId?: string;
      displayName: string;
    }
  ): Promise<void> {
    try {
      const embedding = await this.generateEmbedding(message.content);
      
      const vector = {
        id: `msg-${message.id}`,
        values: embedding,
        metadata: {
          text: message.content,
          userId: message.userId,
          channelId: message.channelId,
          threadId: message.threadId,
          displayName: message.displayName,
          type: 'chat_message',
          timestamp: new Date().toISOString()
        }
      };
      
      await this.pinecone.upsertVectors([vector], 'primary');
    } catch (error) {
      console.error('Error adding chat message to RAG:', error);
      throw error;
    }
  }

  private reciprocalRankFusion(resultSets: SearchResult[][]): SearchResult[] {
    const k = 60;
    const scores: Map<string, number> = new Map();
    
    resultSets.forEach(results => {
      results.forEach((result, rank) => {
        const rrf_score = 1 / (k + rank + 1);
        const currentScore = scores.get(result.id) || 0;
        scores.set(result.id, currentScore + rrf_score);
      });
    });

    const uniqueResults = new Map<string, SearchResult>();
    resultSets.flat().forEach(result => {
      if (!uniqueResults.has(result.id)) {
        uniqueResults.set(result.id, result);
      }
    });

    return Array.from(uniqueResults.values())
      .map(result => ({
        ...result,
        score: scores.get(result.id) || 0,
      }))
      .sort((a, b) => b.score - a.score);
  }

  private async getLastNMessagesForUser(userId: string, n: number): Promise<{ content: string }[]> {
    try {
      const result = await this.pool.query(
        `SELECT content 
         FROM messages 
         WHERE user_id = $1 
           AND NOT is_ai_generated 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [userId, n]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting last messages for user:', error);
      return [];
    }
  }

  async generateAvatarResponse(
    query: string, 
    userId: string, 
    userName: string
  ): Promise<string> {
    try {
      // Get style examples from user's last messages
      const lastMessages = await this.getLastNMessagesForUser(userId, 3);
      const userExamples = lastMessages.map(
        (m, i) => `Example #${i+1}: "${m.content}"`
      ).join('\n');

      // Build system prompt with style examples
      const systemPrompt = `
        You are ${userName}'s AI avatar. 
        Mirror their style, tone, and persona. 
        Here are their last 3 messages to illustrate how they typically speak:
        ${userExamples}
      `;

      // Get context from RAG search
      const searchResults = await this.searchWithHypothetical(query, userId);
      const context = searchResults
        .map(r => r.content)
        .join('\n\nNext relevant context:\n');

      const client = new OpenAI({
        apiKey: this.openaiApiKey
      });

      // Generate response
      const response = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Context:\n${context}\n\nQuery: ${query}` }
        ],
        temperature: 0.7
      });

      return response.choices[0].message.content || '';
    } catch (error) {
      console.error('Error generating avatar response:', error);
      throw error;
    }
  }
} 
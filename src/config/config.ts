import { AppConfig } from '../types/rag.types';
import dotenv from 'dotenv';

dotenv.config();


export const config: AppConfig = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
  },
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || '',
    indexName: process.env.PINECONE_INDEX || '',
  },
  langchain: {
    apiKey: process.env.LANGCHAIN_API_KEY || '',
    project: process.env.LANGCHAIN_PROJECT || '',
    tracingV2: process.env.LANGCHAIN_TRACING_V2 === 'true',
  },
  moondream: {
    apiKey: process.env.MOONDREAM_API_KEY || '',
  },
};

// Validate configuration
const validateConfig = () => {
  const requiredEnvVars = [
    'OPENAI_API_KEY',
    'PINECONE_API_KEY',
    'PINECONE_INDEX',
    'LANGCHAIN_API_KEY',
  ];

  const missingVars = requiredEnvVars.filter(
    (varName) => !process.env[varName]
  );

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}`
    );
  }
};

validateConfig(); 
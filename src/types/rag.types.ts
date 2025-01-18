export interface OpenAIConfig {
    apiKey: string;
    model: string;
  }
  
  export interface PineconeConfig {
    apiKey: string;
    indexName: string;
  }
  
  export interface LangChainConfig {
    apiKey: string;
    project: string;
    tracingV2: boolean;
  }
  
  export interface MoondreamConfig {
    apiKey: string;
  }
  
  export interface AppConfig {
    openai: OpenAIConfig;
    pinecone: PineconeConfig;
    langchain: LangChainConfig;
    moondream: MoondreamConfig;
  }
  
  export interface SearchResult {
    id: string;
    score: number;
    content: string;
    metadata: Record<string, any>;
  }
  
  export interface PineconeDocument {
    id: string;
    values: number[];
    metadata?: Record<string, any>;
  }
  
  export interface PineconeSearchResult extends SearchResult {
    values?: number[];
  }
  
  export interface PineconeService {
    index: string;
    namespace?: string;
  } 
// Supabase client for NeuralSynch Memory Packet system
// Handles direct database connections and edge function calls

export interface MemoryContext {
  success: boolean;
  client_id: string;
  session_number: number;
  context_prompt: string;
  locked_decisions_count: number;
  memory_records_count: number;
  anti_amnesia_status: string;
}

export interface SessionWriteback {
  session_number: number;
  client_id: string;
  objective: string;
  outcome_summary: string;
  files_created?: Array<{path: string; description: string; type: string}>;
  files_modified?: Array<{path: string; changes: string; type: string}>;
  decisions_made?: Array<{decision: string; rationale: string; type: string}>;
  next_session_tasks?: Array<{task: string; priority: number; context: string}>;
  handoff_prompt?: string;
}

export class NeuralSynchClient {
  private baseUrl: string;
  private anonKey: string;

  constructor() {
    // NeuralSynch Supabase connection
    this.baseUrl = 'https://udafklielwqdppnagtwc.supabase.co';
    this.anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYWZrbGllbHdxZHBwbmFndHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNTgxNzgsImV4cCI6MjA4OTkzNDE3OH0.0ueCBWNfdZGOHsLlJW9P3tUQ7QgD7tGmM6CQ1ZbOaAQ';
  }

  async readMemoryPacket(clientId: string = 'viralbrain'): Promise<MemoryContext> {
    try {
      const response = await fetch(
        `${this.baseUrl}/functions/v1/retrieve-context-packet?client_id=${clientId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Memory read failed:', error);
      throw new Error(`Failed to read memory packet: ${error.message}`);
    }
  }

  async writeSessionBack(writeback: SessionWriteback): Promise<{success: boolean; message: string}> {
    try {
      const response = await fetch(
        `${this.baseUrl}/functions/v1/write-session-back`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey
          },
          body: JSON.stringify(writeback)
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Memory write failed:', error);
      throw new Error(`Failed to write session back: ${error.message}`);
    }
  }

  async searchMemory(query: string, clientId: string = 'viralbrain', limit: number = 10): Promise<any> {
    try {
      // Direct database query for memory search
      const response = await fetch(
        `${this.baseUrl}/rest/v1/ns_memory_records?client_id=eq.${clientId}&content=ilike.*${query}*&limit=${limit}`,
        {
          headers: {
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Memory search failed:', error);
      throw new Error(`Failed to search memory: ${error.message}`);
    }
  }

  async getMemoryStats(clientId: string = 'viralbrain'): Promise<any> {
    try {
      const queries = [
        `${this.baseUrl}/rest/v1/ns_locked_decisions?client_id=eq.${clientId}&select=count`,
        `${this.baseUrl}/rest/v1/ns_memory_records?client_id=eq.${clientId}&select=count`,
        `${this.baseUrl}/rest/v1/ns_session_writebacks?client_id=eq.${clientId}&select=count`
      ];

      const responses = await Promise.all(
        queries.map(url => fetch(url, {
          headers: {
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey,
            'Prefer': 'count=exact'
          }
        }))
      );

      const counts = await Promise.all(responses.map(r => r.headers.get('Content-Range')));
      
      return {
        locked_decisions: parseInt(counts[0]?.split('/')[1] || '0'),
        memory_records: parseInt(counts[1]?.split('/')[1] || '0'), 
        session_writebacks: parseInt(counts[2]?.split('/')[1] || '0'),
        client_id: clientId,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Memory stats failed:', error);
      throw new Error(`Failed to get memory stats: ${error.message}`);
    }
  }
}

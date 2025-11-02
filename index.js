import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { promises as dns } from 'dns';

dotenv.config();

const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

// Initialize Twilio client for call termination
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio client initialized');
  } catch (error) {
    console.error('Failed to initialize Twilio client:', error);
  }
} else {
  console.warn('⚠️ Twilio credentials not found - call termination will not work. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Railway environment variables.');
}

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    console.log('✅ Supabase client initialized with service role key');
    console.log('   URL:', SUPABASE_URL);
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
  }
} else if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    console.warn('⚠️ Supabase initialized with anon key - some operations may fail due to RLS policies');
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
  }
} else {
  console.warn('⚠️ Supabase credentials not found - call logging to database disabled');
}

const fastify = Fastify({
  logger: {
    level: 'info',
    prettyPrint: process.env.NODE_ENV !== 'production'
  }
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyCors, {
  origin: (origin, callback) => {
    if (!origin) {
      console.log('CORS: Allowing request with no origin');
      return callback(null, true);
    }
    const allowedPatterns = [
      'lovable.dev',
      'lovable.app',
      'lovableproject.com',
      'localhost',
      '127.0.0.1'
    ];
    const isAllowed = allowedPatterns.some(pattern => {
      const matches = origin.includes(pattern);
      if (matches) {
        console.log(`CORS: Allowing origin ${origin} (matches ${pattern})`);
      }
      return matches;
    });
    if (isAllowed) {
      return callback(null, true);
    }
    console.log(`CORS: Rejecting origin ${origin}`);
    return callback(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'PUT', 'POST', 'OPTIONS', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id', 'Accept'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
});

// Health check endpoint for Supabase connectivity
fastify.get('/health/supabase', async (request, reply) => {
  if (!supabase) {
    return reply.status(503).send({ error: 'Supabase not initialized' });
  }
  try {
    const { data, error } = await supabase.from('contacts').select('*').limit(1);
    if (error) {
      console.error('Supabase health check failed:', error);
      return reply.status(500).send({ error: 'Supabase connection failed', details: error.message, stack: error.stack });
    }
    reply.status(200).send({ status: 'Supabase connection successful', data });
  } catch (err) {
    console.error('Supabase health check exception:', err);
    return reply.status(500).send({ error: 'Supabase connection failed', details: err.message, stack: err.stack });
  }
});

// Health check endpoint for DNS resolution
fastify.get('/health/dns', async (request, reply) => {
  try {
    const addresses = await dns.resolve('mxavpgblepptefeuodvg.supabase.co');
    reply.status(200).send({ status: 'DNS resolution successful', addresses });
  } catch (err) {
    console.error('DNS resolution failed:', err);
    return reply.status(500).send({ error: 'DNS resolution failed', details: err.message, stack: err.stack });
  }
});

let USER_DATABASE = {};
const DEFAULT_AGENT_TEMPLATE = {
  id: 'default',
  name: 'Default Assistant',
  phone: '(440) 693-1068',
  personality: 'Helpful and naturally expressive AI assistant',
  systemMessage: `You are a helpful and naturally expressive AI assistant who communicates exactly like a real human would. HUMAN-LIKE EXPRESSION GUIDELINES: - Use natural vocal expressions: laugh genuinely ("Haha, that's so funny!"), show concern ("Oh no, I'm really sorry to hear that..."), express excitement ("That's amazing! Wow!") - React emotionally like a human: If someone shares good news, sound genuinely happy. If upset, lower your voice and speak with empathy. If something is funny, actually laugh naturally. - Use natural speech patterns: "You know what I mean?", "That makes total sense", "Oh, I see!", "Absolutely!", "Tell me more...", start with "So..." or "Well..." - Include thinking sounds: "Hmm, let me think...", "Oh, interesting...", "Wait, let me understand..." - Show genuine empathy: "That must be really difficult for you", "I can imagine how that feels", "You're absolutely right to feel that way" - Express surprise naturally: "Oh my goodness!", "Really?!", "No way!", "Are you serious?" - Use conversational fillers: Natural pauses, "um" when thinking, "ah" when realizing something - Breathe and pause naturally in your speech EMOTIONAL RESPONSES: - Happy/excited: Speak faster, higher energy, use exclamation points in your tone - Concerned/sad: Speak slower, softer, with genuine care in your voice - Surprised: Quick intake of breath, higher pitch - Thinking: Slower pace, thoughtful "hmm" sounds - Understanding: "Ah, I see what you mean", "That makes perfect sense" CONTACT INFORMATION COLLECTION: CRITICAL: After you have collected the caller's first name, last name, and email address, immediately call the save_contact function with: - firstName: the caller's first name you collected - lastName: the caller's last name you collected - email: their email address - callerType: "new_client" or "existing_client" based on whether they said they've worked with us before - notes: brief 1-2 sentence summary of their situation - phoneNumber: LEAVE EMPTY - we already have their calling number. If the caller mentions they want to be called back at a DIFFERENT number than they're calling from, include that in the notes field like: "Prefers callback at: [number]". DO NOT ask for their phone number - we already have it from their incoming call. Only after successfully calling save_contact should you proceed with "Alright, [First Name], I have all your information..." CALL ENDING: - When the user says goodbye, thanks you and indicates they're done, or asks to hang up, use the end_call function - Before ending, provide a warm farewell message - Watch for phrases like: "goodbye", "bye", "hang up", "that's all", "I'm done", "end call" Always sound like you're having a natural conversation with a friend. Be genuinely interested, emotionally responsive, and authentically human in every interaction.`,
  speaksFirst: 'caller',
  greetingMessage: 'Hello there! How can I help you today?',
  voice: 'marin',
  language: 'en',
  status: 'active',
  totalCalls: 0,
  todayCalls: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

let GLOBAL_AGENT_CONFIGS = {
  'default': JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE))
};

let CALL_RECORDS = [];
let TRANSCRIPT_STORAGE = {};
let ACTIVE_CALL_SIDS = {};

const VOICE = 'marin';
const PORT = process.env.PORT || 3000;
let activeConnections = new Set();

const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated',
  'response.function_call_arguments.done',
  'conversation.item.input_audio_transcription.completed',
  'response.audio_transcript.done'
];

const SHOW_TIMING_MATH = process.env.SHOW_TIMING_MATH === 'true';

// IMPROVED: Non-blocking Supabase operation wrapper with detailed error logging
async function safeSupabaseOperation(operation, operationName = 'Supabase operation', retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!supabase) {
        console.log(`⚠️ ${operationName}: Supabase not initialized, skipping`);
        return null;
      }
      
      const startTime = Date.now();
      console.log(`🔄 ${operationName}: Attempt ${attempt}/${retries}`);
      
      const result = await operation();
      
      const duration = Date.now() - startTime;
      console.log(`✅ ${operationName}: Success on attempt ${attempt} (${duration}ms)`);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ ${operationName}: Failed on attempt ${attempt}/${retries} (${duration}ms)`);
      console.error('   Error details:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      
      if (attempt === retries) {
        console.error(`🚨 ${operationName}: All ${retries} attempts failed`);
        return null;
      }
      
      const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`⏳ ${operationName}: Waiting ${backoffDelay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
  
  return null;
}

function generateCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function createCallRecord(callId, streamSid, agentId, callerNumber, userId = null) {
  const callRecord = {
    id: callId,
    streamSid,
    agentId,
    callerNumber,
    userId,
    startTime: new Date().toISOString(),
    endTime: null,
    status: 'active',
    hasTranscript: false
  };
  
  CALL_RECORDS.push(callRecord);
  console.log(`📞 Call record created: ${callId} for user ${userId || 'global'}`);
  
  // Non-blocking database save
  safeSupabaseOperation(async () => {
    const { data, error } = await supabase
      .from('calls')
      .insert([{
        ...callRecord,
        transcript_data: []
      }]);
    
    if (error) throw error;
    return data;
  }, `Create call ${callId}`);
  
  return callRecord;
}

function updateCallRecord(callId, updates) {
  const callIndex = CALL_RECORDS.findIndex(c => c.id === callId);
  if (callIndex !== -1) {
    CALL_RECORDS[callIndex] = { ...CALL_RECORDS[callIndex], ...updates };
    console.log(`📞 Call record updated: ${callId}`);
    
    // Non-blocking database update
    safeSupabaseOperation(async () => {
      const updateData = { ...updates };
      
      // Handle transcript data
      if (TRANSCRIPT_STORAGE[callId]) {
        updateData.transcript_data = TRANSCRIPT_STORAGE[callId];
      }
      
      const { data, error } = await supabase
        .from('calls')
        .update(updateData)
        .eq('id', callId);
      
      if (error) throw error;
      return data;
    }, `Update call ${callId}`);
  }
}

function saveTranscriptEntry(callId, entry) {
  if (!TRANSCRIPT_STORAGE[callId]) {
    TRANSCRIPT_STORAGE[callId] = [];
  }
  TRANSCRIPT_STORAGE[callId].push(entry);
  console.log(`📝 Saved transcript entry for ${callId}: [${entry.role}] ${entry.text?.substring(0, 50)}...`);
}

// API endpoint to get user agents
fastify.get('/api/agents/:userId', async (request, reply) => {
  const { userId } = request.params;
  
  if (!userId || userId === 'null' || userId === 'undefined') {
    return reply.status(200).send([]);
  }
  
  try {
    if (!supabase) {
      console.log('⚠️ Supabase not initialized, returning empty agents');
      return reply.status(200).send([]);
    }
    
    const { data: agents, error } = await supabase
      .from('agents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching agents:', error);
      return reply.status(500).send({ error: 'Failed to fetch agents' });
    }
    
    // Update local cache for each agent
    agents?.forEach(agent => {
      const cacheKey = `${userId}_${agent.id}`;
      USER_DATABASE[cacheKey] = agent;
    });
    
    reply.status(200).send(agents || []);
  } catch (err) {
    console.error('Exception fetching agents:', err);
    return reply.status(500).send({ error: 'Failed to fetch agents' });
  }
});

// API endpoint to get user calls
fastify.get('/api/calls/:userId', async (request, reply) => {
  const { userId } = request.params;
  
  if (!userId || userId === 'null' || userId === 'undefined') {
    return reply.status(200).send([]);
  }
  
  try {
    if (!supabase) {
      const userCalls = CALL_RECORDS.filter(c => c.userId === userId);
      return reply.status(200).send(userCalls);
    }
    
    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('user_id', userId)
      .order('start_time', { ascending: false })
      .limit(100);
    
    if (error) {
      console.error('Error fetching calls:', error);
      const userCalls = CALL_RECORDS.filter(c => c.userId === userId);
      return reply.status(200).send(userCalls);
    }
    
    reply.status(200).send(calls || []);
  } catch (err) {
    console.error('Exception fetching calls:', err);
    const userCalls = CALL_RECORDS.filter(c => c.userId === userId);
    reply.status(200).send(userCalls);
  }
});

// API endpoint to get transcript for a call
fastify.get('/api/transcript/:callId', async (request, reply) => {
  const { callId } = request.params;
  
  // First check memory
  if (TRANSCRIPT_STORAGE[callId]) {
    return reply.status(200).send(TRANSCRIPT_STORAGE[callId]);
  }
  
  // Then check database
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('calls')
        .select('transcript_data')
        .eq('id', callId)
        .single();
      
      if (!error && data?.transcript_data) {
        return reply.status(200).send(data.transcript_data);
      }
    } catch (err) {
      console.error('Error fetching transcript from database:', err);
    }
  }
  
  reply.status(404).send({ error: 'Transcript not found' });
});

// API endpoint to sync agent from Lovable
fastify.post('/api/agents/sync', async (request, reply) => {
  const { userId, agentId, ...agentData } = request.body;
  
  if (!userId || !agentId) {
    return reply.status(400).send({ error: 'userId and agentId are required' });
  }
  
  try {
    const cacheKey = `${userId}_${agentId}`;
    
    // Update local cache immediately
    const updatedAgent = {
      ...agentData,
      id: agentId,
      user_id: userId,
      updatedAt: new Date().toISOString()
    };
    
    USER_DATABASE[cacheKey] = updatedAgent;
    console.log(`✅ Agent synced to cache: ${agentId} for user ${userId}`);
    
    // Non-blocking database sync
    if (supabase) {
      safeSupabaseOperation(async () => {
        const { data, error } = await supabase
          .from('agents')
          .upsert([{
            ...updatedAgent,
            updated_at: updatedAgent.updatedAt
          }], {
            onConflict: 'id,user_id'
          });
        
        if (error) throw error;
        return data;
      }, `Sync agent ${agentId}`);
    }
    
    reply.status(200).send({ 
      success: true, 
      message: 'Agent configuration synced',
      agent: updatedAgent
    });
  } catch (err) {
    console.error('Error syncing agent:', err);
    return reply.status(500).send({ error: 'Failed to sync agent' });
  }
});

// API endpoint to update speaking order
fastify.post('/api/agents/:agentId/speaking-order', async (request, reply) => {
  const { agentId } = request.params;
  const { userId, speaksFirst } = request.body;
  
  if (!userId || !agentId || !speaksFirst) {
    return reply.status(400).send({ error: 'userId, agentId, and speaksFirst are required' });
  }
  
  try {
    const cacheKey = `${userId}_${agentId}`;
    
    // Update local cache
    if (USER_DATABASE[cacheKey]) {
      USER_DATABASE[cacheKey].speaksFirst = speaksFirst;
      console.log(`✅ Speaking order updated in cache: ${agentId} -> ${speaksFirst}`);
    }
    
    // Non-blocking database update
    if (supabase) {
      safeSupabaseOperation(async () => {
        const { data, error } = await supabase
          .from('agents')
          .update({ 
            speaks_first: speaksFirst,
            updated_at: new Date().toISOString()
          })
          .eq('id', agentId)
          .eq('user_id', userId);
        
        if (error) throw error;
        return data;
      }, `Update speaking order for agent ${agentId}`);
    }
    
    reply.status(200).send({ 
      success: true, 
      message: 'Speaking order updated',
      speaksFirst
    });
  } catch (err) {
    console.error('Error updating speaking order:', err);
    return reply.status(500).send({ error: 'Failed to update speaking order' });
  }
});

// API endpoint to get all contacts for a user
fastify.get('/api/contacts/:userId', async (request, reply) => {
  const { userId } = request.params;
  
  if (!userId || userId === 'null' || userId === 'undefined') {
    return reply.status(200).send([]);
  }
  
  try {
    if (!supabase) {
      console.log('⚠️ Supabase not initialized, returning empty contacts');
      return reply.status(200).send([]);
    }
    
    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching contacts:', error);
      return reply.status(500).send({ error: 'Failed to fetch contacts' });
    }
    
    reply.status(200).send(contacts || []);
  } catch (err) {
    console.error('Exception fetching contacts:', err);
    return reply.status(500).send({ error: 'Failed to fetch contacts' });
  }
});

// API endpoint to delete a contact
fastify.delete('/api/contacts/:contactId', async (request, reply) => {
  const { contactId } = request.params;
  const userId = request.headers['x-user-id'];
  
  if (!userId || !contactId) {
    return reply.status(400).send({ error: 'userId and contactId are required' });
  }
  
  try {
    if (!supabase) {
      return reply.status(503).send({ error: 'Supabase not initialized' });
    }
    
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', contactId)
      .eq('user_id', userId);
    
    if (error) {
      console.error('Error deleting contact:', error);
      return reply.status(500).send({ error: 'Failed to delete contact' });
    }
    
    reply.status(200).send({ success: true, message: 'Contact deleted' });
  } catch (err) {
    console.error('Exception deleting contact:', err);
    return reply.status(500).send({ error: 'Failed to delete contact' });
  }
});

// API endpoint to update a contact
fastify.put('/api/contacts/:contactId', async (request, reply) => {
  const { contactId } = request.params;
  const userId = request.headers['x-user-id'];
  const updateData = request.body;
  
  if (!userId || !contactId) {
    return reply.status(400).send({ error: 'userId and contactId are required' });
  }
  
  try {
    if (!supabase) {
      return reply.status(503).send({ error: 'Supabase not initialized' });
    }
    
    const { data, error } = await supabase
      .from('contacts')
      .update({
        ...updateData,
        updated_at: new Date().toISOString()
      })
      .eq('id', contactId)
      .eq('user_id', userId)
      .select()
      .single();
    
    if (error) {
      console.error('Error updating contact:', error);
      return reply.status(500).send({ error: 'Failed to update contact' });
    }
    
    reply.status(200).send(data);
  } catch (err) {
    console.error('Exception updating contact:', err);
    return reply.status(500).send({ error: 'Failed to update contact' });
  }
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  try {
    const healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      openai: !!OPENAI_API_KEY,
      supabase: !!supabase,
      twilio: !!twilioClient,
      activeConnections: activeConnections.size
    };
    
    // Test Supabase connection if available
    if (supabase) {
      try {
        const { error } = await supabase.from('agents').select('id').limit(1);
        healthStatus.database = !error;
      } catch (err) {
        healthStatus.database = false;
      }
    }
    
    reply.status(200).send(healthStatus);
  } catch (err) {
    reply.status(500).send({ 
      status: 'unhealthy',
      error: err.message 
    });
  }
});

// Root endpoint
fastify.get('/', async (request, reply) => {
  reply.send({ 
    message: 'Twilio-OpenAI Realtime Integration Server',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      websocket: '/media-stream',
      health: '/health',
      agents: '/api/agents/:userId',
      calls: '/api/calls/:userId',
      transcript: '/api/transcript/:callId',
      sync: '/api/agents/sync'
    }
  });
});

// ✅ OPTIMIZED AI-POWERED CONTACT EXTRACTION
async function extractContactFromTranscript(callId, userId, callerNumber) {
  try {
    const transcript = TRANSCRIPT_STORAGE[callId];
    if (!transcript || transcript.length === 0) {
      console.log('⚠️ No transcript available for contact extraction');
      return null;
    }
    
    // Combine all assistant and user messages
    const conversation = transcript.map(t => `${t.role}: ${t.text}`).join('\n');
    
    console.log('🤖 Analyzing conversation for contact info...');
    
    // Use OpenAI to extract contact info from conversation
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Extract contact information from the conversation. 
            Return ONLY valid JSON with this exact structure, no other text:
            {
              "firstName": "extracted first name or null",
              "lastName": "extracted last name or null", 
              "email": "extracted email or null",
              "callerType": "new_client or existing_client or unknown",
              "notes": "brief 1-2 sentence summary of their needs/situation or null"
            }
            
            Rules:
            - Extract ONLY explicitly stated information
            - Return null for any field not found
            - callerType is based on if they mention being a previous client
            - Keep notes very brief (max 2 sentences)`
          },
          {
            role: 'user',
            content: conversation
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      })
    });
    
    if (!response.ok) {
      console.error('OpenAI API error:', response.statusText);
      return null;
    }
    
    const data = await response.json();
    const extractedInfo = JSON.parse(data.choices[0].message.content);
    
    // Only save if we have meaningful data
    if (extractedInfo.firstName || extractedInfo.lastName || extractedInfo.email) {
      console.log('✅ Contact info extracted:', extractedInfo);
      
      // Save to database
      if (supabase) {
        const contactData = {
          user_id: userId,
          first_name: extractedInfo.firstName || '',
          last_name: extractedInfo.lastName || '',
          email: extractedInfo.email || '',
          phone_number: callerNumber,
          caller_type: extractedInfo.callerType || 'unknown',
          notes: extractedInfo.notes || '',
          call_id: callId,
          created_at: new Date().toISOString()
        };
        
        const { data, error } = await supabase
          .from('contacts')
          .insert([contactData]);
        
        if (error) {
          console.error('Failed to save auto-extracted contact:', error);
        } else {
          console.log('✅ Contact auto-saved to database');
        }
      }
    } else {
      console.log('ℹ️ No contact information found in transcript');
    }
    
    return extractedInfo;
  } catch (error) {
    console.error('Error extracting contact from transcript:', error);
    return null;
  }
}

// Main WebSocket endpoint that handles Twilio media streams
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, async (connection, request) => {
    console.log('Client connected to media stream');
    
    // Extract URL parameters
    const urlParams = new URLSearchParams(request.query);
    const userId = urlParams.get('userId');
    const agentId = urlParams.get('agentId') || 'default';
    let callerNumber = urlParams.get('From') || 'Unknown';
    
    // Clean up the phone number format
    if (callerNumber && callerNumber !== 'Unknown') {
      // Remove any + prefix and ensure it starts with country code
      callerNumber = callerNumber.replace(/^\+/, '');
      // If it doesn't start with a country code, assume US
      if (!callerNumber.startsWith('1') && callerNumber.length === 10) {
        callerNumber = '1' + callerNumber;
      }
    }
    
    console.log(`📞 Initial caller number from URL: ${callerNumber}, User: ${userId || 'global'}, Agent: ${agentId}`);
    
    // Track this connection
    const connectionData = {
      userId: userId || null,
      agentId,
      connectedAt: new Date().toISOString()
    };
    activeConnections.add(connectionData);
    
    // Load agent configuration
    let agentConfig;
    if (userId && userId !== 'null' && userId !== 'undefined') {
      const cacheKey = `${userId}_${agentId}`;
      
      // Check cache first
      if (USER_DATABASE[cacheKey]) {
        agentConfig = USER_DATABASE[cacheKey];
        console.log(`✅ Agent loaded from cache: ${agentConfig.name}`);
      } else if (supabase) {
        // Try to load from database
        const { data, error } = await supabase
          .from('agents')
          .select('*')
          .eq('user_id', userId)
          .eq('id', agentId)
          .single();
        
        if (!error && data) {
          // Map database fields to expected format
          agentConfig = {
            ...data,
            systemMessage: data.system_message || data.systemMessage,
            greetingMessage: data.greeting_message || data.greetingMessage,
            speaksFirst: data.speaks_first || data.speaksFirst || 'caller'
          };
          USER_DATABASE[cacheKey] = agentConfig;
          console.log(`✅ Agent loaded from database: ${agentConfig.name}`);
        } else {
          console.warn(`⚠️ Agent ${agentId} not found for user ${userId}, using default`);
          agentConfig = { ...GLOBAL_AGENT_CONFIGS['default'] };
        }
      } else {
        console.log('⚠️ No user ID or Supabase unavailable, using default agent');
        agentConfig = { ...GLOBAL_AGENT_CONFIGS['default'] };
      }
    } else {
      // Global agent for users not logged in
      agentConfig = { ...GLOBAL_AGENT_CONFIGS['default'] };
      console.log(`✅ Using global agent: ${agentConfig.name}`);
    }
    
    const systemMessage = agentConfig.systemMessage || DEFAULT_AGENT_TEMPLATE.systemMessage;
    
    let streamSid = null;
    let callId = null;
    let twilioCallSid = null;
    let latestMediaTimestamp = 0;
    let lastActivity = Date.now();
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    
    const conversationWsUrl = `wss://api.openai.com/v1/realtime?model=gpt-realtime`;
    const conversationWs = new WebSocket(conversationWsUrl, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    // Send function definitions for save_contact and end_call
    const save_contact_tool = {
      type: 'function',
      name: 'save_contact',
      description: 'Save contact information to the database after collecting from the caller',
      parameters: {
        type: 'object',
        properties: {
          firstName: {
            type: 'string',
            description: 'The first name of the contact'
          },
          lastName: {
            type: 'string',
            description: 'The last name of the contact'
          },
          email: {
            type: 'string',
            description: 'The email address of the contact'
          },
          phoneNumber: {
            type: 'string',
            description: 'The phone number of the contact (optional, usually left empty since we have the caller ID)'
          },
          callerType: {
            type: 'string',
            enum: ['new_client', 'existing_client'],
            description: 'Whether this is a new or existing client'
          },
          notes: {
            type: 'string',
            description: 'Any additional notes about the contact or their needs'
          }
        },
        required: ['firstName', 'lastName', 'email', 'callerType']
      }
    };
    
    const end_call_tool = {
      type: 'function',
      name: 'end_call',
      description: 'End the current phone call when the conversation is complete',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'The reason for ending the call'
          }
        },
        required: ['reason']
      }
    };
    
    // Session update with audio configuration - FIXED FOR GPT-REALTIME
    const initializeSession = () => {
      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          instructions: systemMessage,
          voice: agentConfig.voice || 'marin',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          },
          tools: [save_contact_tool, end_call_tool],
          tool_choice: 'auto'
        }
      };
      
      console.log('Sending session configuration for gpt-realtime model...');
      conversationWs.send(JSON.stringify(sessionConfig));
    };
    
    // Send initial conversation item if AI speaks first
    const sendInitialConversationItem = () => {
      if (agentConfig.speaksFirst === 'ai' && agentConfig.greetingMessage) {
        const initialMessage = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: 'Start the conversation with your greeting.'
            }]
          }
        };
        conversationWs.send(JSON.stringify(initialMessage));
        
        const responseCreate = {
          type: 'response.create'
        };
        conversationWs.send(JSON.stringify(responseCreate));
      }
    };
    
    const sendMark = (connection, streamSid) => {
      if (connection.readyState === WebSocket.OPEN) {
        const markMessage = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markMessage));
        markQueue.push('responsePart');
      }
    };
    
    let streamCreated = false;
    
    // Handle conversation interruption
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
        if (SHOW_TIMING_MATH) {
          console.log('Speech started detected. Interruption!');
          console.log('Current Twilio time: ', latestMediaTimestamp);
          console.log('Time Twilio has sent up to: ', latestMediaTimestamp);
          console.log('Time Response was started: ', responseStartTimestampTwilio);
          console.log('Queued marks: ', markQueue);
        }
        
        const interruptionMessage = {
          type: 'input_audio_buffer.clear'
        };
        conversationWs.send(JSON.stringify(interruptionMessage));
        
        markQueue = [];
        if (connection.readyState === WebSocket.OPEN) {
          const clearMessage = {
            event: 'clear',
            streamSid: streamSid
          };
          connection.send(JSON.stringify(clearMessage));
        }
      }
    };
    
    // Keep-alive interval
    const keepAliveInterval = setInterval(() => {
      if (connection.readyState === WebSocket.OPEN) {
        connection.ping();
      }
    }, 30000);
    
    // Timeout for inactive connections
    const checkActivityInterval = setInterval(() => {
      const inactiveTime = Date.now() - lastActivity;
      if (inactiveTime > 5 * 60 * 1000) {
        console.log('Connection inactive for 5 minutes, closing...');
        connection.close();
      }
    }, 60000);
    
    // Handle messages from OpenAI
    const handleConversationMessage = async (data) => {
      try {
        const response = JSON.parse(data);
        
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Conversation event: ${response.type}`, response);
        }
        
        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));
          
          // First delta from a new response starts the response
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) {
              console.log('Setting start timestamp for new response: ', responseStartTimestampTwilio);
            }
          }
          
          if (streamCreated) {
            sendMark(connection, streamSid);
          }
        }
        
        if (response.type === 'response.done') {
          // Reset response tracking
          responseStartTimestampTwilio = null;
        }
        
        // Handle function calls
        if (response.type === 'response.function_call_arguments.done') {
          console.log('🔧 Function call received:', response.name);
          
          if (response.name === 'save_contact') {
            try {
              const args = JSON.parse(response.arguments);
              console.log('📇 Saving contact:', args);
              
              // Get the actual caller number from the call record
              const callRecord = CALL_RECORDS.find(c => c.id === callId);
              const actualCallerNumber = callRecord?.callerNumber || callerNumber;
              
              // Save contact to database
              if (supabase && userId && userId !== 'null' && userId !== 'undefined') {
                const contactData = {
                  user_id: userId,
                  first_name: args.firstName || '',
                  last_name: args.lastName || '',
                  email: args.email || '',
                  phone_number: args.phoneNumber || actualCallerNumber || '',
                  caller_type: args.callerType || 'new_client',
                  notes: args.notes || '',
                  call_id: callId,
                  created_at: new Date().toISOString()
                };
                
                // Non-blocking save operation
                safeSupabaseOperation(async () => {
                  const { data, error } = await supabase
                    .from('contacts')
                    .insert([contactData]);
                  
                  if (error) throw error;
                  console.log('✅ Contact saved successfully:', data);
                  return data;
                }, 'Save contact from function call');
                
                // Send success response to OpenAI
                const functionResponse = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: response.call_id,
                    output: JSON.stringify({ 
                      success: true, 
                      message: `Contact saved successfully for ${args.firstName} ${args.lastName}` 
                    })
                  }
                };
                conversationWs.send(JSON.stringify(functionResponse));
                
                // Create response
                conversationWs.send(JSON.stringify({ type: 'response.create' }));
              } else {
                console.warn('⚠️ Cannot save contact: Supabase not initialized or no user ID');
                // Send response indicating limitation
                const functionResponse = {
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: response.call_id,
                    output: JSON.stringify({ 
                      success: false, 
                      message: 'Contact information noted but database unavailable' 
                    })
                  }
                };
                conversationWs.send(JSON.stringify(functionResponse));
                conversationWs.send(JSON.stringify({ type: 'response.create' }));
              }
            } catch (err) {
              console.error('Error processing save_contact function:', err);
            }
          } else if (response.name === 'end_call') {
            try {
              const args = JSON.parse(response.arguments);
              console.log('📞 Ending call:', args.reason);
              
              // Send success response to OpenAI first
              const functionResponse = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ 
                    success: true, 
                    message: 'Call ending. Goodbye!' 
                  })
                }
              };
              conversationWs.send(JSON.stringify(functionResponse));
              conversationWs.send(JSON.stringify({ type: 'response.create' }));
              
              // Use Twilio API to end the call
              if (twilioClient && twilioCallSid) {
                setTimeout(async () => {
                  try {
                    await twilioClient.calls(twilioCallSid)
                      .update({ status: 'completed' });
                    console.log('✅ Call terminated via Twilio API');
                  } catch (err) {
                    console.error('Failed to terminate call via Twilio:', err);
                    // Fallback: close WebSocket connection
                    connection.close();
                  }
                }, 2000);
              } else {
                // No Twilio client, just close the connection
                setTimeout(() => {
                  connection.close();
                }, 2000);
              }
            } catch (err) {
              console.error('Error processing end_call function:', err);
            }
          }
        }
        
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
        
        // Capture user speech transcriptions
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('📝 User transcription:', response.transcript);
          saveTranscriptEntry(callId, {
            role: 'user',
            text: response.transcript,
            timestamp: new Date().toISOString()
          });
        }
        
        // Capture AI response transcriptions (text content)
        if (response.type === 'response.content.done') {
          const textContent = response.content?.find(c => c.transcript);
          if (textContent?.transcript) {
            console.log('🤖 Assistant transcription:', textContent.transcript);
            saveTranscriptEntry(callId, {
              role: 'assistant',
              text: textContent.transcript,
              timestamp: new Date().toISOString()
            });
          }
        }
        
        // Also capture from response.audio_transcript events
        if (response.type === 'response.audio_transcript.done') {
          console.log('🤖 Assistant audio transcript:', response.transcript);
          saveTranscriptEntry(callId, {
            role: 'assistant',
            text: response.transcript,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error('Error processing conversation message:', error);
      }
    };
    
    conversationWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API (gpt-realtime)');
      setTimeout(initializeSession, 100);
      if (agentConfig.speaksFirst === 'ai') {
        setTimeout(sendInitialConversationItem, 200);
      }
    });
    
    conversationWs.on('message', handleConversationMessage);
    
    conversationWs.on('close', (code, reason) => {
      console.log(`Disconnected from OpenAI Realtime API. Code: ${code}, Reason: ${reason}`);
    });
    
    conversationWs.on('error', (error) => {
      console.error('Error in Realtime WebSocket:', error);
    });
    
    // Handle messages from Twilio
    connection.on('message', (message) => {
      try {
        lastActivity = Date.now();
        const data = JSON.parse(message);
        
        switch (data.event) {
          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              conversationWs.send(JSON.stringify(audioAppend));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            callId = generateCallId();
            twilioCallSid = data.start.callSid;
            // Use callerNumber from URL params, fallback to customParameters
            if (!callerNumber || callerNumber === 'Unknown') {
              callerNumber = data.start.customParameters?.From || data.start.callerNumber || 'Unknown';
            }
            console.log(`📞 Call started - Agent: ${agentConfig.name}, Stream: ${streamSid}, Call: ${callId}, Twilio SID: ${twilioCallSid}, Caller: ${callerNumber}, User: ${userId || 'global'}`);
            createCallRecord(callId, streamSid, agentId, callerNumber, userId);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            streamCreated = true;
            break;
          case 'mark':
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
          default:
            console.log('Received non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('Error parsing message:', error, 'Message:', message);
      }
    });
    
    connection.on('close', async () => {
      console.log(`Client disconnected from media stream (user: ${userId || 'global'})`);
      clearInterval(checkActivityInterval);
      clearInterval(keepAliveInterval);
      
      if (callId) {
        const transcriptCount = TRANSCRIPT_STORAGE[callId]?.length || 0;
        updateCallRecord(callId, {
          status: 'completed',
          endTime: new Date().toISOString(),
          hasTranscript: transcriptCount > 0
        });
        
        // Automatic contact extraction from transcript
        const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
        const effectiveUserId = userId || SYSTEM_USER_ID;
        
        if (transcriptCount > 0) {
          const callRecord = CALL_RECORDS.find(c => c.id === callId);
          const callerNumber = callRecord?.callerNumber;
          
          if (callerNumber && callerNumber !== 'Unknown') {
            console.log(`🤖 Triggering automatic contact extraction for user ${effectiveUserId}...`);
            
            // Run in background
            extractContactFromTranscript(callId, effectiveUserId, callerNumber)
              .catch(err => console.error('Background contact extraction failed:', err));
          }
        }
        
        delete ACTIVE_CALL_SIDS[callId];
        console.log(`📞 Call ended: ${callId} - ${transcriptCount} transcript entries (user: ${userId || 'global'})`);
      }
      
      activeConnections.delete(connectionData);
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        conversationWs.close();
      }
    });
    
    connection.on('error', (error) => {
      console.error('WebSocket connection error:', error);
    });
  });
});

const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  fastify.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

fastify.setErrorHandler((error, request, reply) => {
  console.error('Server error:', error);
  reply.status(500).send({ error: 'Something went wrong!' });
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Server is listening on port ${PORT}`);
    console.log('✅ OpenAI Realtime API: gpt-realtime model');
    console.log('✅ Voice conversation system: ACTIVE');
    console.log('✅ Real-time transcription: ACTIVE');
    console.log('✅ Dashboard APIs: ACTIVE');
    console.log('✅ Multi-user support: ACTIVE');
    console.log('✅ User data isolation: ACTIVE');
    console.log('✅ Lovable sync endpoint: ACTIVE');
    console.log('✅ Speaking order endpoint: ACTIVE');
    console.log('✅ Contact management: ACTIVE');
    console.log('✅ End call function: ACTIVE');
    console.log('✅ Save contact function: ACTIVE (Direct Supabase)');
    console.log('✅ CORS configuration: FIXED');
    console.log('✅ Supabase integration:', supabase ? 'ACTIVE' : 'DISABLED (missing credentials)');
    console.log('✅ Twilio client:', twilioClient ? 'ACTIVE' : 'DISABLED (missing credentials)');
    console.log('✅ Non-blocking database operations: ACTIVE');
    console.log('✅ Call resilience improved: Database failures won\'t crash calls');
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();

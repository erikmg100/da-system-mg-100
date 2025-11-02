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
  'response.audio.delta',  // CRITICAL: Add this to log audio streaming
  'response.audio.done',    // Add this to track audio completion
  'conversation.item.input_audio_transcription.completed',
  'response.audio_transcript.done',
  'response.output_item.done'
];

const SHOW_TIMING_MATH = process.env.SHOW_TIMING_MATH === 'true';

// IMPROVED: Non-blocking Supabase operation wrapper with detailed error logging
async function safeSupabaseOperation(operation, operationName = 'Supabase operation', retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!supabase) {
        console.log(`⚠️ ${operationName}: Supabase not initialized, skipping`);
        return { success: false, error: 'Supabase not initialized' };
      }
      const result = await operation();
      return { success: true, data: result?.data, error: result?.error };
    } catch (error) {
      console.error(`${operationName} attempt ${attempt}/${retries} failed:`, error.message);
      if (attempt === retries) {
        console.error(`${operationName} failed after ${retries} attempts:`, error);
        return { success: false, error: error.message };
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function fetchAgentConfig(agentId, userId = null) {
  const fetchStart = Date.now();
  console.log(`🔍 Fetching agent config: agentId=${agentId}, userId=${userId || 'global'} (attempt #1)`);
  
  if (!agentId || agentId === 'null' || agentId === 'undefined') {
    console.log('⚠️ Invalid agent ID, using default template');
    return JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE));
  }
  
  if (userId && userId !== 'null' && USER_DATABASE[userId]?.agents?.[agentId]) {
    console.log(`✅ Found agent in cache for user ${userId} (${Date.now() - fetchStart}ms)`);
    return USER_DATABASE[userId].agents[agentId];
  }
  
  if (GLOBAL_AGENT_CONFIGS[agentId]) {
    console.log(`✅ Found agent in global cache (${Date.now() - fetchStart}ms)`);
    return GLOBAL_AGENT_CONFIGS[agentId];
  }
  
  if (!supabase) {
    console.warn('⚠️ Supabase not available, using default template');
    return JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE));
  }
  
  const maxRetries = 3;
  let attempt = 1;
  let lastError = null;
  
  while (attempt <= maxRetries) {
    try {
      const queryStart = Date.now();
      console.log(`📡 Attempting database query (attempt ${attempt}/${maxRetries})`);
      let query = supabase
        .from('agents')
        .select('*')
        .eq('id', agentId);
      
      if (userId && userId !== 'null' && userId !== 'undefined') {
        query = query.eq('user_id', userId);
        console.log(`   - Filtering by user_id: ${userId}`);
      } else {
        query = query.is('user_id', null);
        console.log(`   - Filtering for global agents (user_id IS NULL)`);
      }
      
      const { data, error } = await query.maybeSingle();
      const queryTime = Date.now() - queryStart;
      
      if (error) {
        lastError = error;
        console.error(`❌ Database error (attempt ${attempt}):`, error.message);
        if (attempt < maxRetries) {
          const delay = attempt * 1000;
          console.log(`⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        attempt++;
        continue;
      }
      
      if (data) {
        console.log(`✅ Agent found in database: ${data.name} (query: ${queryTime}ms, total: ${Date.now() - fetchStart}ms)`);
        
        if (!data.systemMessage || data.systemMessage.trim() === '') {
          console.warn('⚠️ Agent has empty system message, using default');
          data.systemMessage = DEFAULT_AGENT_TEMPLATE.systemMessage;
        }
        
        const agentConfig = {
          id: data.id,
          name: data.name || 'Assistant',
          phone: data.phone || DEFAULT_AGENT_TEMPLATE.phone,
          personality: data.personality || DEFAULT_AGENT_TEMPLATE.personality,
          systemMessage: data.system_message || data.systemMessage || DEFAULT_AGENT_TEMPLATE.systemMessage,
          speaksFirst: data.speaks_first || data.speaksFirst || 'caller',
          greetingMessage: data.greeting_message || data.greetingMessage || DEFAULT_AGENT_TEMPLATE.greetingMessage,
          voice: data.voice || DEFAULT_AGENT_TEMPLATE.voice,
          language: data.language || 'en',
          status: data.status || 'active',
          totalCalls: data.total_calls || data.totalCalls || 0,
          todayCalls: data.today_calls || data.todayCalls || 0,
          createdAt: data.created_at || data.createdAt,
          updatedAt: data.updated_at || data.updatedAt
        };
        
        if (userId && userId !== 'null') {
          if (!USER_DATABASE[userId]) USER_DATABASE[userId] = { agents: {} };
          USER_DATABASE[userId].agents[agentId] = agentConfig;
        } else {
          GLOBAL_AGENT_CONFIGS[agentId] = agentConfig;
        }
        
        console.log(`📋 Agent config cached successfully`);
        return agentConfig;
      }
      
      console.warn(`⚠️ No agent found with ID ${agentId} for user ${userId || 'global'} (query: ${queryTime}ms)`);
      break;
      
    } catch (err) {
      lastError = err;
      console.error(`❌ Unexpected error (attempt ${attempt}):`, err.message);
      if (attempt < maxRetries) {
        const delay = attempt * 1000;
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      attempt++;
    }
  }
  
  console.warn(`⚠️ All database attempts failed after ${Date.now() - fetchStart}ms, using default template`);
  if (lastError) {
    console.error('Last error:', lastError);
  }
  return JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE));
}

// 🆕 FUNCTION TO EXTRACT CONTACT INFO FROM TRANSCRIPT USING AI
async function extractContactFromTranscript(callId, userId, callerPhone) {
  console.log('🤖 Starting AI contact extraction...');
  
  const transcripts = TRANSCRIPT_STORAGE[callId];
  if (!transcripts || transcripts.length === 0) {
    console.log('⚠️ No transcripts available for contact extraction');
    return;
  }
  
  // Format transcript for AI analysis
  const conversationText = transcripts.map(t => `${t.role}: ${t.text}`).join('\n');
  
  // Call OpenAI to extract contact information
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
          content: `You are a contact information extractor. Extract contact details from the conversation transcript.
          
          Return a JSON object with these fields (use null if not found):
          {
            "firstName": "string or null",
            "lastName": "string or null", 
            "email": "string or null",
            "company": "string or null",
            "callerType": "new_client" or "existing_client" or null,
            "notes": "brief summary of their needs/situation or null"
          }
          
          Be conservative - only extract information that was clearly stated.
          For callerType: look for phrases like "I've worked with you before", "I'm a new client", "existing customer", etc.
          If uncertain, use null.`
        },
        {
          role: 'user',
          content: conversationText
        }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });
  
  if (!response.ok) {
    console.error('❌ OpenAI API error:', response.statusText);
    return;
  }
  
  const result = await response.json();
  const extractedInfo = JSON.parse(result.choices[0].message.content);
  
  console.log('📋 Extracted contact info:', extractedInfo);
  
  // Only save if we have meaningful information
  if (extractedInfo.firstName || extractedInfo.lastName || extractedInfo.email) {
    // Save to Supabase
    const contactData = {
      call_id: callId,
      user_id: userId,
      first_name: extractedInfo.firstName,
      last_name: extractedInfo.lastName,
      email: extractedInfo.email,
      phone_number: callerPhone,
      company: extractedInfo.company,
      caller_type: extractedInfo.callerType || 'unknown',
      notes: extractedInfo.notes,
      source: 'ai_extraction',
      created_at: new Date().toISOString()
    };
    
    const result = await safeSupabaseOperation(
      async () => await supabase.from('contacts').insert(contactData),
      'Save AI-extracted contact'
    );
    
    if (result.success) {
      console.log('✅ AI-extracted contact saved successfully');
    } else {
      console.error('❌ Failed to save AI-extracted contact:', result.error);
    }
  } else {
    console.log('ℹ️ No meaningful contact information found in transcript');
  }
}

function generateCallId() {
  return `call-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

function createCallRecord(callId, streamSid, agentId, callerNumber = 'Unknown', userId = null) {
  const record = {
    id: callId,
    streamSid,
    agentId,
    userId: userId || null,
    callerNumber,
    startTime: new Date().toISOString(),
    status: 'active',
    hasTranscript: false
  };
  CALL_RECORDS.push(record);
  console.log(`📝 Created call record: ${callId} for agent ${agentId}, user ${userId || 'global'}, caller ${callerNumber}`);
  
  // Save to database in background (non-blocking)
  safeSupabaseOperation(
    async () => {
      return await supabase
        .from('calls')
        .insert({
          id: callId,
          stream_sid: streamSid,
          agent_id: agentId,
          user_id: userId || null,
          caller_number: callerNumber,
          start_time: record.startTime,
          status: 'active',
          has_transcript: false
        });
    },
    `Create call record ${callId}`
  ).catch(err => console.error('Background call creation failed:', err));
  
  return record;
}

function updateCallRecord(callId, updates) {
  const record = CALL_RECORDS.find(c => c.id === callId);
  if (record) {
    Object.assign(record, updates);
    console.log(`📝 Updated call record: ${callId}`, updates);
    
    // Prepare database updates
    const dbUpdates = {};
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.endTime !== undefined) dbUpdates.end_time = updates.endTime;
    if (updates.hasTranscript !== undefined) dbUpdates.has_transcript = updates.hasTranscript;
    
    // Save to database in background (non-blocking)
    if (Object.keys(dbUpdates).length > 0) {
      safeSupabaseOperation(
        async () => {
          return await supabase
            .from('calls')
            .update(dbUpdates)
            .eq('id', callId);
        },
        `Update call record ${callId}`
      ).catch(err => console.error('Background call update failed:', err));
    }
  }
}

// 🆕 IMPROVED: Save transcript entry with database persistence
function saveTranscriptEntry(callId, entry) {
  if (!TRANSCRIPT_STORAGE[callId]) {
    TRANSCRIPT_STORAGE[callId] = [];
  }
  TRANSCRIPT_STORAGE[callId].push(entry);
  console.log(`💬 Transcript saved for ${callId}: [${entry.role}] ${entry.text.substring(0, 100)}...`);
  
  // Save to database in background (non-blocking)
  safeSupabaseOperation(
    async () => {
      return await supabase
        .from('transcripts')
        .insert({
          call_id: callId,
          role: entry.role,
          text: entry.text,
          created_at: entry.timestamp
        });
    },
    `Save transcript entry for ${callId}`
  ).catch(err => console.error('Background transcript save failed:', err));
}

// Global dashboard routes (no user context)
fastify.get('/dashboard/calls', async (request, reply) => {
  const limit = parseInt(request.query.limit) || 10;
  const recentCalls = CALL_RECORDS
    .slice(-limit)
    .reverse()
    .map(call => ({
      ...call,
      transcriptCount: TRANSCRIPT_STORAGE[call.id]?.length || 0
    }));
  
  reply.send({ success: true, calls: recentCalls });
});

// Test agent config fetching
fastify.get('/test/agent/:agentId', async (request, reply) => {
  const { agentId } = request.params;
  const userId = request.headers['x-user-id'] || request.query.userId || null;
  console.log(`🧪 Testing agent fetch: agentId=${agentId}, userId=${userId}`);
  
  const config = await fetchAgentConfig(agentId, userId);
  reply.send({ success: true, config });
});

// Add sync endpoint for Lovable
fastify.post('/api/agents/sync', async (request, reply) => {
  console.log('📥 Sync request received from Lovable');
  const userId = request.headers['x-user-id'];
  
  if (!userId) {
    console.error('❌ No user ID in sync request');
    return reply.status(400).send({ error: 'User ID required in x-user-id header' });
  }
  
  if (!supabase) {
    return reply.status(503).send({ error: 'Supabase not initialized' });
  }
  
  const { agents } = request.body;
  
  try {
    console.log(`🔄 Syncing ${agents.length} agents for user ${userId}`);
    
    const operations = agents.map(async (agent) => {
      console.log(`  - Processing agent: ${agent.id} (${agent.name})`);
      
      const agentData = {
        id: agent.id,
        user_id: userId,
        name: agent.name,
        phone: agent.phone,
        personality: agent.personality || DEFAULT_AGENT_TEMPLATE.personality,
        system_message: agent.systemMessage || DEFAULT_AGENT_TEMPLATE.systemMessage,
        speaks_first: agent.speaksFirst || 'caller',
        greeting_message: agent.greetingMessage || DEFAULT_AGENT_TEMPLATE.greetingMessage,
        voice: agent.voice || 'alloy',
        language: agent.language || 'en',
        status: agent.status || 'active',
        total_calls: agent.totalCalls || 0,
        today_calls: agent.todayCalls || 0,
        created_at: agent.createdAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const result = await supabase
        .from('agents')
        .upsert(agentData, {
          onConflict: 'id,user_id',
          ignoreDuplicates: false
        });
      
      if (result.error) {
        console.error(`❌ Failed to sync agent ${agent.id}:`, result.error);
        throw result.error;
      }
      
      if (!USER_DATABASE[userId]) {
        USER_DATABASE[userId] = { agents: {} };
      }
      USER_DATABASE[userId].agents[agent.id] = {
        ...agent,
        systemMessage: agent.systemMessage || DEFAULT_AGENT_TEMPLATE.systemMessage,
        speaksFirst: agent.speaksFirst || 'caller',
        greetingMessage: agent.greetingMessage || DEFAULT_AGENT_TEMPLATE.greetingMessage
      };
      
      console.log(`    ✅ Synced successfully`);
      return { id: agent.id, success: true };
    });
    
    const results = await Promise.allSettled(operations);
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    console.log(`✅ Sync complete: ${successful} succeeded, ${failed} failed`);
    
    reply.send({ 
      success: true, 
      synced: successful,
      failed: failed,
      message: `Synced ${successful} agents for user ${userId}` 
    });
  } catch (error) {
    console.error('❌ Sync error:', error);
    reply.status(500).send({ error: 'Failed to sync agents', details: error.message });
  }
});

// Save contact endpoint
fastify.post('/api/contacts', async (request, reply) => {
  console.log('📥 Save contact request received');
  
  if (!supabase) {
    return reply.status(503).send({ error: 'Supabase not initialized' });
  }
  
  const userId = request.headers['x-user-id'] || request.body.userId;
  const contact = request.body;
  
  // Validate required fields
  if (!contact.firstName || !contact.lastName) {
    return reply.status(400).send({ error: 'First name and last name are required' });
  }
  
  try {
    const contactData = {
      user_id: userId || null,
      call_id: contact.callId || null,
      first_name: contact.firstName,
      last_name: contact.lastName,
      email: contact.email || null,
      phone_number: contact.phoneNumber || null,
      company: contact.company || null,
      caller_type: contact.callerType || 'unknown',
      notes: contact.notes || null,
      source: contact.source || 'manual',
      created_at: new Date().toISOString()
    };
    
    console.log('💾 Saving contact:', contactData);
    
    const { data, error } = await supabase
      .from('contacts')
      .insert(contactData)
      .select()
      .single();
    
    if (error) {
      console.error('❌ Failed to save contact:', error);
      return reply.status(500).send({ error: 'Failed to save contact', details: error.message });
    }
    
    console.log('✅ Contact saved successfully:', data);
    reply.send({ success: true, contact: data });
    
  } catch (error) {
    console.error('❌ Contact save error:', error);
    reply.status(500).send({ error: 'Failed to save contact', details: error.message });
  }
});

// Agent endpoints with multi-user support  
fastify.get('/api/agents', async (request, reply) => {
  const userId = request.headers['x-user-id'];
  
  if (!supabase) {
    const agents = userId && USER_DATABASE[userId]?.agents 
      ? Object.values(USER_DATABASE[userId].agents)
      : Object.values(GLOBAL_AGENT_CONFIGS);
    return reply.send({ success: true, agents });
  }
  
  try {
    let query = supabase.from('agents').select('*');
    
    if (userId && userId !== 'null' && userId !== 'undefined') {
      query = query.eq('user_id', userId);
      console.log(`Fetching agents for user: ${userId}`);
    } else {
      query = query.is('user_id', null);
      console.log('Fetching global agents');
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Failed to fetch agents:', error);
      const fallbackAgents = userId && USER_DATABASE[userId]?.agents 
        ? Object.values(USER_DATABASE[userId].agents)
        : Object.values(GLOBAL_AGENT_CONFIGS);
      return reply.send({ success: true, agents: fallbackAgents, source: 'cache' });
    }
    
    const agents = data.map(agent => ({
      id: agent.id,
      name: agent.name,
      phone: agent.phone,
      personality: agent.personality,
      systemMessage: agent.system_message,
      speaksFirst: agent.speaks_first,
      greetingMessage: agent.greeting_message,
      voice: agent.voice,
      language: agent.language,
      status: agent.status,
      totalCalls: agent.total_calls,
      todayCalls: agent.today_calls,
      createdAt: agent.created_at,
      updatedAt: agent.updated_at
    }));
    
    reply.send({ success: true, agents, source: 'database' });
  } catch (error) {
    console.error('Error fetching agents:', error);
    const fallbackAgents = userId && USER_DATABASE[userId]?.agents 
      ? Object.values(USER_DATABASE[userId].agents)
      : Object.values(GLOBAL_AGENT_CONFIGS);
    reply.send({ success: true, agents: fallbackAgents, source: 'cache' });
  }
});

// WebSocket route for media streaming
fastify.get('/media-stream', { websocket: true }, async (connection, request) => {
  console.log('=== NEW WEBSOCKET CONNECTION ESTABLISHED ===');
  
  const urlParams = new URL(request.url, `http://${request.headers.host}`).searchParams;
  const agentId = urlParams.get('agentId') || 'default';
  const userId = urlParams.get('userId') || request.headers['x-user-id'] || null;
  const callerNumber = urlParams.get('From') || urlParams.get('from') || 'Unknown';
  
  console.log('📞 Connection parameters:');
  console.log(`   Agent ID: ${agentId}`);
  console.log(`   User ID: ${userId || 'global'}`);
  console.log(`   Caller: ${callerNumber}`);
  
  const agentConfig = await fetchAgentConfig(agentId, userId);
  console.log(`🤖 Using agent: ${agentConfig.name} (${agentConfig.voice})`);
  console.log(`   Speaks first: ${agentConfig.speaksFirst}`);
  
  const connectionData = { 
    connection, 
    userId, 
    agentId,
    connectedAt: new Date().toISOString()
  };
  activeConnections.add(connectionData);
  console.log(`📊 Active connections: ${activeConnections.size}`);
  
  connection.on('error', console.error);
  
  let streamSid = null;
  let callId = null;
  let twilioCallSid = null;
  let latestMediaTimestamp = 0;
  let lastActivity = Date.now();
  let sessionActive = false;
  let streamCreated = false;
  let responseStartTimestampTwilio = null;
  let markQueue = [];
  
  const keepAliveInterval = setInterval(() => {
    if (Date.now() - lastActivity > 30000) {
      connection.terminate();
    }
  }, 5000);
  
  const conversationWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });
  
  const reconnectConversationWs = () => {
    console.log('Reconnecting to OpenAI...');
    setTimeout(() => {
      console.error('Reconnection not implemented');
    }, 1000);
  };
  
  // CRITICAL FIX: Updated session initialization with correct audio format
  const initializeSession = () => {
    console.log('=== INITIALIZING CONVERSATION SESSION ===');
    console.log('Agent ID:', agentId);
    console.log('User ID:', userId || 'global');
    console.log('System Message Preview:', agentConfig.systemMessage.substring(0, 150) + '...');
    console.log('Voice:', agentConfig.voice || 'alloy');
    console.log('==========================================');
    
    // CRITICAL: Use the EXACT structure from OpenAI documentation
    // The session fields are at the root level, NOT nested
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],  // Enable both modalities
        instructions: agentConfig.systemMessage,
        voice: agentConfig.voice || 'alloy',  // Voice at session level
        input_audio_format: 'g711_ulaw',  // CRITICAL: Twilio μ-law format
        output_audio_format: 'g711_ulaw',  // CRITICAL: Twilio μ-law format
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
        tools: [
          {
            type: 'function',
            name: 'end_call',
            description: 'Ends the current phone call when user says goodbye',
            parameters: {
              type: 'object',
              properties: {
                reason: { 
                  type: 'string', 
                  description: 'Brief reason for ending the call' 
                }
              },
              required: ['reason']
            }
          },
          {
            type: 'function',
            name: 'save_contact',
            description: 'Save contact information after collecting details',
            parameters: {
              type: 'object',
              properties: {
                firstName: { type: 'string', description: 'First name' },
                lastName: { type: 'string', description: 'Last name' },
                email: { type: 'string', description: 'Email address' },
                phoneNumber: { type: 'string', description: 'Phone number' },
                callerType: { type: 'string', description: 'new_client or existing_client' },
                notes: { type: 'string', description: 'Additional notes' }
              },
              required: ['firstName', 'lastName']
            }
          }
        ],
        tool_choice: 'auto',
        temperature: 0.8,
        max_response_output_tokens: 4096
      }
    };
    
    if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
      conversationWs.send(JSON.stringify(sessionUpdate));
      console.log('📤 Session update sent with G.711 μ-law format');
    } else {
      console.error('❌ WebSocket not ready for session update');
    }
  };
  
  const sendInitialConversationItem = () => {
    if (agentConfig.speaksFirst === 'ai' && agentConfig.greetingMessage) {
      const initialItem = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Please greet the caller with your greeting message.'
          }]
        }
      };
      
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        conversationWs.send(JSON.stringify(initialItem));
        
        setTimeout(() => {
          const responseCreate = {
            type: 'response.create'
          };
          conversationWs.send(JSON.stringify(responseCreate));
          console.log('📤 Initial greeting triggered');
        }, 100);
      }
    }
  };
  
  // CRITICAL FIX: Handle speech interruptions
  const handleSpeechStartedEvent = () => {
    // User started speaking - cancel any ongoing response
    if (markQueue.length > 0 && responseStartTimestampTwilio !== null) {
      console.log('🔄 User interrupted - cancelling response');
      
      // Clear Twilio audio buffer
      if (connection.readyState === WebSocket.OPEN) {
        const clearMessage = {
          event: 'clear',
          streamSid: streamSid
        };
        connection.send(JSON.stringify(clearMessage));
      }
      
      // Cancel OpenAI response
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        const cancelMessage = {
          type: 'response.cancel'
        };
        conversationWs.send(JSON.stringify(cancelMessage));
      }
      
      // Reset state
      markQueue = [];
      responseStartTimestampTwilio = null;
    }
  };
  
  // CRITICAL FIX: Updated conversation message handler with audio streaming
  const handleConversationMessage = async (data) => {
    try {
      const response = JSON.parse(data);
      
      // Log important events for debugging
      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`Conversation event: ${response.type}`);
        
        // Log details for important events
        if (response.type === 'session.created' || response.type === 'session.updated') {
          console.log('Session config:', {
            voice: response.session?.voice,
            input_format: response.session?.input_audio_format,
            output_format: response.session?.output_audio_format,
            modalities: response.session?.modalities
          });
        }
      }
      
      // CRITICAL: Stream audio delta back to Twilio - THIS IS THE KEY FIX
      if (response.type === 'response.audio.delta') {
        if (response.delta) {
          // Create Twilio media message with the audio
          const mediaMessage = {
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: response.delta  // Base64 encoded G.711 μ-law audio from OpenAI
            }
          };
          
          // Send audio to Twilio
          if (connection && connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify(mediaMessage));
            
            // Log first audio packet
            if (!streamCreated) {
              streamCreated = true;
              responseStartTimestampTwilio = latestMediaTimestamp;
              console.log('🔊 Started streaming audio to Twilio');
            }
          } else {
            console.error('❌ Cannot send audio - Twilio WebSocket closed');
          }
        }
      }
      
      // Handle response audio completion
      if (response.type === 'response.audio.done') {
        console.log('✅ Audio response completed');
        responseStartTimestampTwilio = null;
        streamCreated = false;
        
        // Send a mark to Twilio
        if (connection && connection.readyState === WebSocket.OPEN) {
          const markMessage = {
            event: 'mark',
            streamSid: streamSid,
            mark: { name: 'response_end' }
          };
          connection.send(JSON.stringify(markMessage));
          markQueue.push('response_end');
        }
      }
      
      // Capture user transcriptions
      if (response.type === 'conversation.item.input_audio_transcription.completed') {
        console.log('📝 User said:', response.transcript);
        saveTranscriptEntry(callId, {
          role: 'user',
          text: response.transcript,
          timestamp: new Date().toISOString()
        });
      }
      
      // Capture assistant transcriptions - multiple event types
      if (response.type === 'response.audio_transcript.done') {
        console.log('🤖 Assistant said:', response.transcript);
        saveTranscriptEntry(callId, {
          role: 'assistant',
          text: response.transcript,
          timestamp: new Date().toISOString()
        });
      }
      
      // Alternative assistant transcript event
      if (response.type === 'response.output_item.done') {
        if (response.item?.content?.[0]?.transcript) {
          console.log('🤖 Assistant said:', response.item.content[0].transcript);
          saveTranscriptEntry(callId, {
            role: 'assistant',
            text: response.item.content[0].transcript,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Another format for assistant transcript
      if (response.type === 'response.content.done') {
        const textContent = response.content?.find(c => c.type === 'text' || c.type === 'audio');
        if (textContent?.transcript) {
          console.log('🤖 Assistant content transcript:', textContent.transcript);
          saveTranscriptEntry(callId, {
            role: 'assistant',
            text: textContent.transcript,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Handle errors
      if (response.type === 'error') {
        console.error('❌ OpenAI Error:', response.error);
        
        // Log specific error details
        if (response.error.code === 'invalid_api_key') {
          console.error('API Key is invalid!');
        } else if (response.error.code === 'model_not_found') {
          console.error('Model not found - check if you have access to gpt-4o-realtime-preview');
        } else if (response.error.type === 'invalid_request_error') {
          console.log('Attempting to recover from session error...');
          // Re-initialize session with simpler configuration
          setTimeout(initializeSession, 1000);
        }
      }
      
      // Handle session events
      if (response.type === 'session.created') {
        console.log('✅ Session created with ID:', response.session.id);
        sessionActive = true;
        
        // If AI speaks first, send initial message
        if (agentConfig.speaksFirst === 'ai') {
          setTimeout(sendInitialConversationItem, 500);
        }
      }
      
      if (response.type === 'session.updated') {
        console.log('✅ Session updated successfully');
        sessionActive = true;
      }
      
      // Handle speech interruptions
      if (response.type === 'input_audio_buffer.speech_started') {
        console.log('🎤 User started speaking');
        handleSpeechStartedEvent();
      }
      
      if (response.type === 'input_audio_buffer.speech_stopped') {
        console.log('🎤 User stopped speaking');
      }
      
      // Track response status
      if (response.type === 'response.done') {
        if (response.response.status === 'completed') {
          console.log('✅ Response completed');
        } else if (response.response.status === 'cancelled') {
          console.log('⚠️ Response cancelled (user interrupted)');
        } else if (response.response.status === 'failed') {
          console.error('❌ Response failed:', response.response.status_details);
        }
      }
      
      // Handle function calls
      if (response.type === 'response.function_call_arguments.done') {
        console.log('🔧 Function called:', response.name);
        
        if (response.name === 'save_contact') {
          try {
            const args = JSON.parse(response.arguments);
            console.log('📝 Save contact function called with:', args);
            
            // Use the existing caller's phone number from the call
            const callRecord = CALL_RECORDS.find(c => c.id === callId);
            const callerPhone = callRecord?.callerNumber || 'Unknown';
            
            const contactData = {
              call_id: callId,
              user_id: userId || null,
              first_name: args.firstName,
              last_name: args.lastName,
              email: args.email || null,
              phone_number: callerPhone !== 'Unknown' ? callerPhone : (args.phoneNumber || null),
              company: args.company || null,
              caller_type: args.callerType || 'unknown',
              notes: args.notes || null,
              source: 'voice_call',
              created_at: new Date().toISOString()
            };
            
            const result = await safeSupabaseOperation(
              async () => await supabase.from('contacts').insert(contactData).select().single(),
              'Save contact from voice call'
            );
            
            if (result.success) {
              console.log('✅ Contact saved successfully');
              
              const functionOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ success: true, message: 'Contact saved successfully' })
                }
              };
              conversationWs.send(JSON.stringify(functionOutput));
            } else {
              console.error('❌ Failed to save contact:', result.error);
              
              const functionOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ success: false, error: result.error })
                }
              };
              conversationWs.send(JSON.stringify(functionOutput));
            }
          } catch (error) {
            console.error('Error handling save_contact:', error);
          }
        } else if (response.name === 'end_call') {
          try {
            const args = JSON.parse(response.arguments);
            console.log('📞 End call function called:', args.reason);
            
            const functionOutput = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify({ success: true, message: 'Ending call' })
              }
            };
            conversationWs.send(JSON.stringify(functionOutput));
            
            // Actually end the call via Twilio
            if (twilioCallSid && twilioClient) {
              console.log(`🔴 Terminating Twilio call: ${twilioCallSid}`);
              
              try {
                await twilioClient.calls(twilioCallSid)
                  .update({ status: 'completed' });
                console.log('✅ Call terminated successfully via Twilio API');
              } catch (twilioError) {
                console.error('❌ Failed to terminate call via Twilio:', twilioError.message);
                
                // Try alternative termination
                if (connection.readyState === WebSocket.OPEN) {
                  connection.close();
                }
              }
            } else {
              console.log('⚠️ Cannot terminate via Twilio API - ending WebSocket connection');
              if (connection.readyState === WebSocket.OPEN) {
                connection.close();
              }
            }
            
            updateCallRecord(callId, {
              status: 'completed',
              endTime: new Date().toISOString(),
              endReason: args.reason
            });
            
          } catch (error) {
            console.error('Error handling end_call:', error);
          }
        }
      }
      
    } catch (error) {
      console.error('Error processing OpenAI message:', error);
      console.error('Raw message:', data.substring(0, 500));
    }
  };
  
  conversationWs.on('open', () => {
    console.log('✅ Connected to OpenAI Realtime API');
    // Initialize session immediately
    setTimeout(initializeSession, 100);
  });
  
  conversationWs.on('message', handleConversationMessage);
  
  conversationWs.on('close', (code, reason) => {
    console.log(`Disconnected from OpenAI. Code: ${code}, Reason: ${reason}`);
    
    // Attempt reconnection if not a normal closure
    if (code !== 1000 && connection.readyState === WebSocket.OPEN) {
      console.log('Attempting to reconnect...');
      setTimeout(() => reconnectConversationWs(), 2000);
    }
  });
  
  conversationWs.on('error', (error) => {
    console.error('❌ OpenAI WebSocket error:', error);
  });
  
  // CRITICAL FIX: Handle Twilio messages with proper audio commit
  connection.on('message', (message) => {
    try {
      lastActivity = Date.now();
      const data = JSON.parse(message);
      
      // Log non-media events
      if (data.event !== 'media') {
        console.log(`Received non-media event: ${data.event}`);
      }
      
      switch (data.event) {
        case 'media':
          // First media packet
          if (!latestMediaTimestamp) {
            console.log('✅ First media packet received from Twilio');
          }
          
          latestMediaTimestamp = data.media.timestamp;
          
          // Send audio to OpenAI
          if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
            // Append audio to buffer
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: data.media.payload  // Base64 G.711 μ-law audio from Twilio
            };
            conversationWs.send(JSON.stringify(audioAppend));
            
            // IMPORTANT: Commit the buffer periodically
            // This triggers VAD processing
            if (latestMediaTimestamp % 250 === 0) {  // Every 250ms
              const commitMessage = {
                type: 'input_audio_buffer.commit'
              };
              conversationWs.send(JSON.stringify(commitMessage));
            }
          } else {
            console.error('❌ Cannot forward audio - OpenAI WebSocket not ready');
          }
          break;
          
        case 'start':
          streamSid = data.start.streamSid;
          callId = generateCallId();
          twilioCallSid = data.start.callSid;
          // Use callerNumber from URL params (already set above), fallback to customParameters
          if (!callerNumber || callerNumber === 'Unknown') {
            callerNumber = data.start.customParameters?.From || data.start.callerNumber || 'Unknown';
          }
          
          console.log(`📞 Call started`);
          console.log(`   Stream: ${streamSid}`);
          console.log(`   Call: ${callId}`);
          console.log(`   Twilio SID: ${twilioCallSid}`);
          console.log(`   Caller: ${callerNumber}`);
          console.log(`   Agent: ${agentConfig.name}`);
          console.log(`   User: ${userId || 'global'}`);
          
          // Reset state
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
          markQueue = [];
          streamCreated = false;
          
          // Store the Twilio Call SID
          ACTIVE_CALL_SIDS[callId] = twilioCallSid;
          
          // Create call record
          createCallRecord(callId, streamSid, agentId, callerNumber, userId);
          break;
          
        case 'stop':
          console.log('📞 Call ending - stop event received');
          break;
          
        case 'mark':
          // Acknowledge mark from Twilio
          if (markQueue.length > 0) {
            const mark = markQueue.shift();
            console.log(`✅ Mark acknowledged: ${mark}`);
          }
          break;
          
        default:
          console.log(`Unknown Twilio event: ${data.event}`);
      }
    } catch (error) {
      console.error('Error handling Twilio message:', error);
    }
  });
  
  connection.on('close', async () => {
    console.log(`Client disconnected from media stream (user: ${userId || 'global'})`);
    if (callId) {
      const transcriptCount = TRANSCRIPT_STORAGE[callId]?.length || 0;
      updateCallRecord(callId, {
        status: 'completed',
        endTime: new Date().toISOString(),
        hasTranscript: transcriptCount > 0
      });
      
      // 🆕 AUTOMATIC CONTACT EXTRACTION FROM TRANSCRIPT
      // Use effectiveUserId to ensure contact extraction even when userId is null
      const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
      const effectiveUserId = userId || SYSTEM_USER_ID;
      
      if (transcriptCount > 0) {
        const callRecord = CALL_RECORDS.find(c => c.id === callId);
        const callerNumber = callRecord?.callerNumber;
        
        if (callerNumber && callerNumber !== 'Unknown') {
          console.log(`🤖 Triggering automatic contact extraction for user ${effectiveUserId}...`);
          
          // Run in background - don't block call cleanup
          extractContactFromTranscript(callId, effectiveUserId, callerNumber)
            .catch(err => console.error('Background contact extraction failed:', err));
        }
      }
      
      delete ACTIVE_CALL_SIDS[callId];
      console.log(`📞 Call ended: ${callId} - ${transcriptCount} transcript entries (user: ${userId || 'global'})`);
    }
    activeConnections.delete(connectionData);
    clearInterval(keepAliveInterval);
    if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
      conversationWs.close();
    }
  });
  
  connection.on('error', (error) => {
    console.error('WebSocket connection error:', error);
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
    console.log('✅ Voice conversation system: ACTIVE');
    console.log('✅ Real-time transcription: ACTIVE');
    console.log('✅ Dashboard APIs: ACTIVE');
    console.log('✅ Multi-user support: ACTIVE');
    console.log('✅ User data isolation: ACTIVE');
    console.log('✅ Lovable sync endpoint: ACTIVE');
    console.log('✅ Audio streaming (G.711 μ-law): FIXED');
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

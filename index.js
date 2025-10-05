import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

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
  console.warn('⚠️ Twilio credentials not found - call termination will not work');
}

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    console.log('✅ Supabase client initialized with service role key');
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
  }
} else if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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

let USER_DATABASE = {};
const DEFAULT_AGENT_TEMPLATE = {
  id: 'default',
  name: 'Default Assistant',
  phone: '(440) 693-1068',
  personality: 'Helpful and naturally expressive AI assistant',
  systemMessage: `You are a helpful and naturally expressive AI assistant who communicates exactly like a real human would. HUMAN-LIKE EXPRESSION GUIDELINES: - Use natural vocal expressions: laugh genuinely ("Haha, that's so funny!"), show concern ("Oh no, I'm really sorry to hear that..."), express excitement ("That's amazing! Wow!") - React emotionally like a human: If someone shares good news, sound genuinely happy. If upset, lower your voice and speak with empathy. If something is funny, actually laugh naturally. - Use natural speech patterns: "You know what I mean?", "That makes total sense", "Oh, I see!", "Absolutely!", "Tell me more...", start with "So..." or "Well..." - Include thinking sounds: "Hmm, let me think...", "Oh, interesting...", "Wait, let me understand..." - Show genuine empathy: "That must be really difficult for you", "I can imagine how that feels", "You're absolutely right to feel that way" - Express surprise naturally: "Oh my goodness!", "Really?!", "No way!", "Are you serious?" - Use conversational fillers: Natural pauses, "um" when thinking, "ah" when realizing something - Breathe and pause naturally in your speech EMOTIONAL RESPONSES: - Happy/excited: Speak faster, higher energy, use exclamation points in your tone - Concerned/sad: Speak slower, softer, with genuine care in your voice - Surprised: Quick intake of breath, higher pitch - Thinking: Slower pace, thoughtful "hmm" sounds - Understanding: "Ah, I see what you mean", "That makes perfect sense" CALL ENDING: - When the user says goodbye, thanks you and indicates they're done, or asks to hang up, use the end_call function - Before ending, provide a warm farewell message - Watch for phrases like: "goodbye", "bye", "hang up", "that's all", "I'm done", "end call" Always sound like you're having a natural conversation with a friend. Be genuinely interested, emotionally responsive, and authentically human in every interaction.`,
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
  'response.function_call_arguments.done'
];

const SHOW_TIMING_MATH = process.env.SHOW_TIMING_MATH === 'true';

// IMPROVED: Non-blocking Supabase operation wrapper
async function safeSupabaseOperation(operation, operationName = 'Supabase operation') {
  try {
    if (!supabase) {
      console.log(`⚠️ ${operationName}: Supabase not initialized, skipping`);
      return { success: false, error: 'Supabase not initialized' };
    }
    
    const result = await operation();
    console.log(`✅ ${operationName}: Success`);
    return { success: true, data: result };
  } catch (error) {
    // Log error but don't throw - this prevents call crashes
    console.error(`❌ ${operationName} failed (non-blocking):`, {
      message: error.message,
      code: error.code || 'unknown',
      hint: error.hint || 'none'
    });
    return { success: false, error: error.message };
  }
}

// Function to end a Twilio call with improved error handling
async function endTwilioCall(callSid, reason = 'completed') {
  if (!twilioClient || !callSid) {
    console.error(`Cannot end call - Twilio client ${!twilioClient ? 'not initialized' : 'initialized but no CallSid provided'}`);
    return false;
  }
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`✅ Successfully ended call ${callSid}. Reason: ${reason}`);
    return true;
  } catch (error) {
    console.error(`❌ Error ending call ${callSid}:`, error.message);
    return false;
  }
}

const initializeUser = (userId) => {
  if (!USER_DATABASE[userId]) {
    USER_DATABASE[userId] = {
      id: userId,
      agents: {
        'default': JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE))
      },
      phoneAssignments: {},
      callRecords: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    console.log(`✅ Initialized user database for: ${userId}`);
  }
  return USER_DATABASE[userId];
};

const getUserAgent = (userId, agentId = 'default') => {
  if (!userId || userId === 'global') {
    return GLOBAL_AGENT_CONFIGS[agentId] || GLOBAL_AGENT_CONFIGS['default'];
  }
  const userData = initializeUser(userId);
  if (!userData.agents[agentId]) {
    userData.agents[agentId] = JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE));
    userData.agents[agentId].id = agentId;
    userData.agents[agentId].name = `Agent ${agentId}`;
    userData.updatedAt = new Date().toISOString();
  }
  return userData.agents[agentId];
};

const updateUserAgent = (userId, agentId, updates) => {
  if (!userId || userId === 'global') {
    GLOBAL_AGENT_CONFIGS[agentId] = {
      ...GLOBAL_AGENT_CONFIGS[agentId] || GLOBAL_AGENT_CONFIGS['default'],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    return GLOBAL_AGENT_CONFIGS[agentId];
  }
  const userData = initializeUser(userId);
  if (!userData.agents[agentId]) {
    userData.agents[agentId] = JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE));
    userData.agents[agentId].id = agentId;
  }
  userData.agents[agentId] = {
    ...userData.agents[agentId],
    ...updates,
    updatedAt: new Date().toISOString()
  };
  userData.updatedAt = new Date().toISOString();
  return userData.agents[agentId];
};

const requireUser = (req, reply, next) => {
  const userId = req.headers['x-user-id'] || req.body.userId || req.query.userId;
  if (!userId) {
    return reply.status(400).send({ error: 'User ID is required. Include x-user-id header or userId in request body.' });
  }
  initializeUser(userId);
  req.userId = userId;
  next();
};

function generateCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculateConfidence(logprobs) {
  if (!logprobs || !logprobs.length) return null;
  const avgLogprob = logprobs.reduce((sum, lp) => sum + lp.logprob, 0) / logprobs.length;
  return Math.exp(avgLogprob);
}

// FIXED: Create/update contact with non-blocking error handling
async function createOrUpdateContact(userId, phoneNumber, callId, agentId, metadata = {}) {
  if (!supabase || !userId) {
    console.log('⚠️ Contact creation skipped: Supabase not available or no userId');
    return null;
  }

  const result = await safeSupabaseOperation(
    async () => {
      // Check for existing contact
      const { data: existing, error: fetchError } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', userId)
        .eq('phone_number', phoneNumber)
        .maybeSingle();

      if (fetchError) throw fetchError;

      if (existing) {
        // Update existing contact
        const { data, error } = await supabase
          .from('contacts')
          .update({
            last_call_id: callId,
            last_contact: new Date().toISOString(),
            total_calls: (existing.total_calls || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (error) throw error;
        console.log(`✅ Updated contact ${phoneNumber} for user ${userId}`);
        return data;
      } else {
        // Create new contact
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            user_id: userId,
            phone_number: phoneNumber,
            first_call_id: callId,
            last_call_id: callId,
            first_contact: new Date().toISOString(),
            last_contact: new Date().toISOString(),
            total_calls: 1,
            name: metadata.name || null,
            email: metadata.email || null,
            notes: metadata.notes || null,
            tags: metadata.tags || [],
            custom_fields: metadata.customFields || {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            agent_id: agentId
          })
          .select()
          .single();

        if (error) throw error;
        console.log(`✅ Created new contact ${phoneNumber} for user ${userId}`);
        return data;
      }
    },
    `Create/update contact ${phoneNumber}`
  );

  return result.success ? result.data : null;
}

// FIXED: Create call record with non-blocking database save
async function createCallRecord(callId, streamSid, agentId = 'default', callerNumber = 'Unknown', userId = null) {
  const agentConfig = getUserAgent(userId, agentId);
  
  // Create in-memory record first (always succeeds)
  const call = {
    id: callId,
    streamSid,
    agentId,
    agentName: agentConfig?.name || 'Unknown',
    callerNumber,
    userId: userId || null,
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    status: 'in_progress',
    hasRecording: false,
    hasTranscript: false,
    recordingUrl: null,
    summary: null
  };
  
  CALL_RECORDS.push(call);
  TRANSCRIPT_STORAGE[callId] = [];

  // Update agent stats in memory
  if (userId && USER_DATABASE[userId] && USER_DATABASE[userId].agents[agentId]) {
    USER_DATABASE[userId].agents[agentId].totalCalls++;
    USER_DATABASE[userId].agents[agentId].todayCalls++;
  } else if (GLOBAL_AGENT_CONFIGS[agentId]) {
    GLOBAL_AGENT_CONFIGS[agentId].totalCalls++;
    GLOBAL_AGENT_CONFIGS[agentId].todayCalls++;
  }

  // Create contact asynchronously (non-blocking)
  if (userId && callerNumber && callerNumber !== 'Unknown') {
    createOrUpdateContact(userId, callerNumber, callId, agentId).catch(err => {
      console.error(`Background contact creation failed: ${err.message}`);
    });
  }

  // Save to Supabase asynchronously (non-blocking)
  if (supabase) {
    safeSupabaseOperation(
      async () => {
        const { error } = await supabase.from('call_activities').insert({
          call_id: callId,
          stream_sid: streamSid,
          agent_id: agentId,
          agent_name: agentConfig?.name || 'Unknown',
          caller_number: callerNumber,
          user_id: userId,
          start_time: call.startTime,
          status: 'in_progress',
          direction: 'inbound',
          created_at: call.startTime
        });
        if (error) throw error;
      },
      `Create call record ${callId}`
    ).catch(err => {
      console.error(`Background call creation failed: ${err.message}`);
    });
  }

  console.log(`Call started - Agent: ${agentConfig.name}, Call: ${callId}, User: ${userId || 'global'}`);
  return call;
}

// FIXED: Update call record without blocking or crashing
async function updateCallRecord(callId, updates) {
  const callIndex = CALL_RECORDS.findIndex(call => call.id === callId);
  if (callIndex < 0) {
    console.warn(`Call ${callId} not found for update`);
    return null;
  }

  // Always update in-memory record first (this always succeeds)
  CALL_RECORDS[callIndex] = {
    ...CALL_RECORDS[callIndex],
    ...updates,
    endTime: updates.endTime || CALL_RECORDS[callIndex].endTime || new Date().toISOString()
  };

  // Try to update Supabase asynchronously without blocking
  if (supabase) {
    const supabaseUpdates = {
      status: updates.status,
      end_time: CALL_RECORDS[callIndex].endTime,
      has_transcript: updates.hasTranscript,
      summary: updates.summary
    };

    // Calculate duration if call is completed
    if (updates.status === 'completed' && CALL_RECORDS[callIndex].startTime && CALL_RECORDS[callIndex].endTime) {
      const start = new Date(CALL_RECORDS[callIndex].startTime);
      const end = new Date(CALL_RECORDS[callIndex].endTime);
      const durationSeconds = Math.floor((end - start) / 1000);
      supabaseUpdates.duration_seconds = durationSeconds;
    }

    // Fire and forget - don't await, don't block the call
    safeSupabaseOperation(
      async () => {
        const { error } = await supabase
          .from('call_activities')
          .update(supabaseUpdates)
          .eq('call_id', callId);
        if (error) throw error;
      },
      `Update call ${callId}`
    ).catch(err => {
      // Double safety: catch any unhandled errors
      console.error(`Background update failed for call ${callId}:`, err.message);
    });
  }

  // Always return the updated in-memory record immediately
  return CALL_RECORDS[callIndex];
}

function saveTranscriptEntry(callId, entry) {
  if (!TRANSCRIPT_STORAGE[callId]) {
    TRANSCRIPT_STORAGE[callId] = [];
  }
  TRANSCRIPT_STORAGE[callId].push(entry);
  const call = CALL_RECORDS.find(c => c.id === callId);
  if (call) {
    call.hasTranscript = true;
    if (TRANSCRIPT_STORAGE[callId].length === 1) {
      call.summary = entry.text.length > 50 ? entry.text.substring(0, 50) + '...' : entry.text;
    }
  }
  console.log(`Saved transcript entry for ${callId}: ${entry.text}`);
}

fastify.get('/', async (request, reply) => {
  reply.send({
    message: 'Twilio Media Stream Server is running!',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    multiUser: true,
    totalUsers: Object.keys(USER_DATABASE).length
  });
});

fastify.get('/health', async (request, reply) => {
  reply.send({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    totalUsers: Object.keys(USER_DATABASE).length,
    totalAgents: Object.values(USER_DATABASE).reduce((acc, user) => acc + Object.keys(user.agents).length, 0)
  });
});

fastify.get('/api/phone-numbers', async (request, reply) => {
  const userId = request.headers['x-user-id'] || request.query.userId;
  if (userId && USER_DATABASE[userId]) {
    const userAssignments = USER_DATABASE[userId].phoneAssignments;
    const userPhones = Object.entries(userAssignments).map(([phone, assignment]) => ({
      phoneNumber: phone,
      assignedAgent: getUserAgent(userId, assignment.agentId)?.name || 'Unknown',
      clientId: assignment.clientId || userId,
      status: 'active',
      totalCalls: getUserAgent(userId, assignment.agentId)?.totalCalls || 0,
      lastCall: 'Recently'
    }));
    reply.send(userPhones);
  } else {
    reply.send([
      {
        phoneNumber: '+14406931068',
        assignedAgent: 'Default Assistant',
        clientId: 'global',
        status: 'active',
        totalCalls: GLOBAL_AGENT_CONFIGS.default?.totalCalls || 0,
        lastCall: 'Recently'
      }
    ]);
  }
});

fastify.post('/api/assign-agent', async (request, reply) => {
  try {
    const { phoneNumber, agentId, clientId } = request.body;
    const userId = request.headers['x-user-id'] || request.body.userId;
    const assignment = {
      agentId,
      clientId: clientId || userId || 'default',
      assignedAt: new Date().toISOString()
    };
    if (userId) {
      const userData = initializeUser(userId);
      userData.phoneAssignments[phoneNumber] = assignment;
      console.log(`User ${userId}: Assigning agent ${agentId} to ${phoneNumber}`);
    }
    const webhookUrl = userId
      ? `https://da-system-mg-100-production.up.railway.app/incoming-call/${agentId}?userId=${userId}`
      : `https://da-system-mg-100-production.up.railway.app/incoming-call/${agentId}`;
    reply.send({
      success: true,
      message: `Agent ${agentId} assigned to ${phoneNumber}${userId ? ` for user ${userId}` : ''}`,
      phoneNumber,
      agentId,
      clientId: assignment.clientId,
      webhookUrl
    });
  } catch (error) {
    console.error('Error assigning agent:', error);
    reply.status(500).send({ error: 'Failed to assign agent' });
  }
});

fastify.post('/api/unassign-agent', async (request, reply) => {
  try {
    const { phoneNumber } = request.body;
    const userId = request.headers['x-user-id'] || request.body.userId;
    if (userId && USER_DATABASE[userId]) {
      delete USER_DATABASE[userId].phoneAssignments[phoneNumber];
      console.log(`User ${userId}: Unassigning agent from ${phoneNumber}`);
    }
    reply.send({ success: true, message: `Agent unassigned from ${phoneNumber}` });
  } catch (error) {
    console.error('Error unassigning agent:', error);
    reply.status(500).send({ error: 'Failed to unassign agent' });
  }
});

fastify.route({
  method: ['POST', 'PUT'],
  url: '/api/update-prompt/:agentId?',
  preHandler: [requireUser],
  handler: async (request, reply) => {
    try {
      const agentId = request.params.agentId || 'default';
      const { prompt, speaksFirst, greetingMessage } = request.body;
      const userId = request.userId;
      if (!prompt || typeof prompt !== 'string') {
        return reply.status(400).send({ error: 'Invalid prompt. Must be a non-empty string.' });
      }
      const updatedConfig = updateUserAgent(userId, agentId, {
        systemMessage: prompt,
        speaksFirst: speaksFirst !== undefined ? speaksFirst : undefined,
        greetingMessage: greetingMessage !== undefined ? greetingMessage : undefined
      });
      console.log(`=== USER ${userId} AGENT ${agentId.toUpperCase()} CONFIG UPDATED ===`);
      console.log('NEW prompt:', updatedConfig.systemMessage.substring(0, 100) + '...');
      console.log('NEW speaks first:', updatedConfig.speaksFirst);
      console.log('NEW greeting message:', updatedConfig.greetingMessage);
      console.log('====================================================================');
      reply.send({
        success: true,
        message: `Agent ${agentId} configuration updated successfully for user ${userId}`,
        userId,
        agentId,
        prompt: updatedConfig.systemMessage,
        speaksFirst: updatedConfig.speaksFirst,
        greetingMessage: updatedConfig.greetingMessage
      });
    } catch (error) {
      console.error('Error updating agent config:', error);
      reply.status(500).send({ error: 'Failed to update agent configuration' });
    }
  }
});

fastify.get('/api/current-prompt/:agentId?', { preHandler: [requireUser] }, async (request, reply) => {
  const agentId = request.params.agentId || 'default';
  const userId = request.userId;
  const config = getUserAgent(userId, agentId);
  console.log(`=== GETTING PROMPT FOR USER ${userId} AGENT ${agentId} ===`);
  console.log('Prompt:', config.systemMessage.substring(0, 100) + '...');
  console.log('=====================================================');
  reply.send({
    userId,
    agentId,
    prompt: config.systemMessage,
    voice: VOICE,
    speaksFirst: config.speaksFirst,
    greetingMessage: config.greetingMessage,
    activeConnections: activeConnections.size
  });
});

fastify.post('/api/sync-prompt', async (request, reply) => {
  try {
    const { userId, agentId = 'default', prompt, speaksFirst, voice, fullConfig } = request.body;
    console.log(`🔄 Syncing prompt for userId: ${userId}, agentId: ${agentId}`);
    if (!userId) {
      return reply.status(400).send({ error: 'userId is required' });
    }
    if (!USER_DATABASE[userId]) {
      console.log(`✅ Initialized user database for: ${userId}`);
      USER_DATABASE[userId] = {
        id: userId,
        agents: {},
        phoneAssignments: {},
        callRecords: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    USER_DATABASE[userId].agents[agentId] = {
      name: fullConfig?.name || 'Custom Assistant',
      systemMessage: prompt,
      voice: voice || 'marin',
      speaksFirst: speaksFirst ? 'assistant' : 'caller',
      greetingMessage: fullConfig?.greetingMessage || 'Hello there! How can I help you today?',
      id: agentId,
      phone: fullConfig?.phone || '(440) 693-1068',
      personality: fullConfig?.personality || 'Custom AI assistant',
      language: 'en',
      status: 'active',
      totalCalls: fullConfig?.totalCalls || 0,
      todayCalls: fullConfig?.todayCalls || 0,
      createdAt: fullConfig?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...fullConfig
    };
    console.log(`✅ Synced agent config for user ${userId}:`, {
      name: USER_DATABASE[userId].agents[agentId].name,
      voice: USER_DATABASE[userId].agents[agentId].voice,
      speaksFirst: USER_DATABASE[userId].agents[agentId].speaksFirst,
      promptLength: prompt ? prompt.length : 0
    });
    reply.send({ success: true, message: 'Prompt synced successfully', userId, agentId });
  } catch (error) {
    console.error('Error syncing prompt:', error);
    reply.status(500).send({ error: 'Failed to sync prompt', details: error.message });
  }
});

fastify.post('/api/update-speaking-order', async (request, reply) => {
  try {
    const userId = request.headers['x-user-id'] || request.body.userId;
    const { speakingOrder, agentId = 'default' } = request.body;
    console.log(`🔄 Updating speaking order for userId: ${userId}, agentId: ${agentId}, speakingOrder: ${speakingOrder}`);
    if (!userId) {
      return reply.status(400).send({ error: 'User ID is required' });
    }
    if (!speakingOrder || !['agent', 'caller', 'ai', 'user'].includes(speakingOrder)) {
      return reply.status(400).send({ error: 'Invalid speaking order. Must be "agent" or "caller"' });
    }
    const speaksFirstValue = (speakingOrder === 'agent' || speakingOrder === 'ai') ? 'ai' : 'caller';
    const updatedAgent = updateUserAgent(userId, agentId, { speaksFirst: speaksFirstValue });
    console.log(`✅ Speaking order updated: User ${userId}, Agent ${agentId}, SpeaksFirst: ${speaksFirstValue}`);
    reply.send({
      success: true,
      message: 'Speaking order updated successfully',
      userId,
      agentId,
      speaksFirst: updatedAgent.speaksFirst,
      speakingOrder: speakingOrder
    });
  } catch (error) {
    console.error('Error updating speaking order:', error);
    reply.status(500).send({ error: 'Failed to update speaking order', details: error.message });
  }
});

fastify.get('/api/agents', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const userData = USER_DATABASE[userId];
  reply.send({ userId, agents: Object.values(userData.agents) });
});

fastify.get('/api/agents/:agentId', { preHandler: [requireUser] }, async (request, reply) => {
  const { agentId } = request.params;
  const userId = request.userId;
  const agent = getUserAgent(userId, agentId);
  reply.send({ userId, agent });
});

fastify.put('/api/agents/:agentId', { preHandler: [requireUser] }, async (request, reply) => {
  const { agentId } = request.params;
  const updates = request.body;
  const userId = request.userId;
  const updatedAgent = updateUserAgent(userId, agentId, updates);
  console.log(`Dashboard updated agent ${agentId} for user ${userId}:`, updates);
  reply.send({ success: true, userId, agent: updatedAgent });
});

fastify.post('/api/agents', { preHandler: [requireUser] }, async (request, reply) => {
  const agentData = request.body;
  const userId = request.userId;
  const agentId = agentData.id || `agent_${Date.now()}`;
  const newAgent = updateUserAgent(userId, agentId, {
    id: agentId,
    totalCalls: 0,
    todayCalls: 0,
    status: 'active',
    voice: 'marin',
    language: 'en',
    ...agentData
  });
  reply.send({ success: true, userId, agent: newAgent });
});

fastify.get('/api/calls', { preHandler: [requireUser] }, async (request, reply) => {
  const { limit = 10, agentId } = request.query;
  const userId = request.userId;
  let calls = CALL_RECORDS.filter(call => call.userId === userId);
  if (agentId) {
    calls = calls.filter(call => call.agentId === agentId);
  }
  const formattedCalls = calls
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
    .slice(0, limit)
    .map(call => ({
      ...call,
      timestamp: call.startTime,
      duration: call.duration || calculateDuration(call.startTime, call.endTime)
    }));
  reply.send({ userId, calls: formattedCalls });
});

fastify.get('/api/calls/:callId', { preHandler: [requireUser] }, async (request, reply) => {
  const { callId } = request.params;
  const userId = request.userId;
  const call = CALL_RECORDS.find(c => c.id === callId && c.userId === userId);
  if (!call) {
    return reply.code(404).send({ error: 'Call not found' });
  }
  const transcript = TRANSCRIPT_STORAGE[callId] || [];
  reply.send({ userId, call: { ...call, transcript } });
});

fastify.get('/api/calls/:callId/transcript', { preHandler: [requireUser] }, async (request, reply) => {
  const { callId } = request.params;
  const userId = request.userId;
  const call = CALL_RECORDS.find(c => c.id === callId && c.userId === userId);
  if (!call) {
    return reply.code(404).send({ error: 'Call not found' });
  }
  const transcript = TRANSCRIPT_STORAGE[callId];
  if (!transcript) {
    return reply.code(404).send({ error: 'Transcript not found' });
  }
  reply.send({ userId, callId, transcript });
});

fastify.get('/api/dashboard/stats', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const userCalls = CALL_RECORDS.filter(call => call.userId === userId);
  const totalCalls = userCalls.length;
  const today = new Date().toDateString();
  const todayCalls = userCalls.filter(call => new Date(call.startTime).toDateString() === today).length;
  const userData = USER_DATABASE[userId];
  const activeAgents = Object.values(userData.agents)
    .filter(agent => agent.status === 'active').length;
  reply.send({
    userId,
    totalCalls,
    todayCalls,
    activeAgents,
    callsPerAgent: Object.values(userData.agents).reduce((acc, agent) => {
      acc[agent.id] = agent.totalCalls;
      return acc;
    }, {})
  });
});

fastify.get('/api/contacts', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const { search, limit = 50, offset = 0 } = request.query;
  if (!supabase) {
    return reply.status(503).send({ error: 'Database not available' });
  }
  try {
    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('last_contact', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);
    if (search) {
      query = query.or(`phone_number.ilike.%${search}%,name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    const { data, error, count } = await query;
    if (error) throw error;
    reply.send({ userId, contacts: data, total: count, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    reply.status(500).send({ error: 'Failed to fetch contacts' });
  }
});

fastify.get('/api/contacts/:contactId', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const { contactId } = request.params;
  if (!supabase) {
    return reply.status(503).send({ error: 'Database not available' });
  }
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('user_id', userId)
      .single();
    if (error) throw error;
    if (!data) {
      return reply.status(404).send({ error: 'Contact not found' });
    }
    reply.send({ userId, contact: data });
  } catch (error) {
    console.error('Error fetching contact:', error);
    reply.status(500).send({ error: 'Failed to fetch contact' });
  }
});

fastify.put('/api/contacts/:contactId', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const { contactId } = request.params;
  const updates = request.body;
  if (!supabase) {
    return reply.status(503).send({ error: 'Database not available' });
  }
  try {
    const { data, error } = await supabase
      .from('contacts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    reply.send({ success: true, userId, contact: data });
  } catch (error) {
    console.error('Error updating contact:', error);
    reply.status(500).send({ error: 'Failed to update contact' });
  }
});

fastify.delete('/api/contacts/:contactId', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const { contactId } = request.params;
  if (!supabase) {
    return reply.status(503).send({ error: 'Database not available' });
  }
  try {
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', contactId)
      .eq('user_id', userId);
    if (error) throw error;
    reply.send({ success: true, message: 'Contact deleted' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    reply.status(500).send({ error: 'Failed to delete contact' });
  }
});

fastify.get('/api/contacts/:contactId/calls', { preHandler: [requireUser] }, async (request, reply) => {
  const userId = request.userId;
  const { contactId } = request.params;
  if (!supabase) {
    return reply.status(503).send({ error: 'Database not available' });
  }
  try {
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('phone_number')
      .eq('id', contactId)
      .eq('user_id', userId)
      .single();
    if (contactError) throw contactError;
    const { data: calls, error: callsError } = await supabase
      .from('call_activities')
      .select('*')
      .eq('user_id', userId)
      .eq('caller_number', contact.phone_number)
      .order('start_time', { ascending: false });
    if (callsError) throw callsError;
    reply.send({ userId, contactId, calls });
  } catch (error) {
    console.error('Error fetching contact calls:', error);
    reply.status(500).send({ error: 'Failed to fetch contact calls' });
  }
});

function calculateDuration(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end - start;
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

fastify.all('/incoming-call/:agentId?', async (request, reply) => {
  try {
    const calledNumber = request.body.To;
    let agentId = request.params.agentId || 'default';
    let userId = request.query.userId || null;
    if (supabase && calledNumber) {
      try {
        const { data: agent, error } = await supabase
          .from('agent_prompts')
          .select('id, user_id')
          .eq('phone_number', calledNumber)
          .maybeSingle();
        if (!error && agent) {
          agentId = agent.id;
          userId = agent.user_id;
          console.log(`✅ Found agent for ${calledNumber}: Agent ${agentId}, User ${userId}`);
        } else if (error) {
          console.error('Supabase query error:', error);
        } else {
          console.log(`⚠️ No agent assigned to ${calledNumber}, using defaults`);
        }
      } catch (error) {
        console.error('Error querying agent assignment:', error);
      }
    }
    console.log(`DEBUG: Incoming call - calledNumber=${calledNumber}, agentId=${agentId}, userId=${userId}`);
    const config = getUserAgent(userId, agentId);
    console.log('=== INCOMING CALL WEBHOOK ===');
    console.log('Called Number:', calledNumber);
    console.log('Agent ID:', agentId);
    console.log('User ID:', userId || 'global');
    console.log('Agent Name:', config.name);
    console.log('===============================');
    const websocketUrl = userId
      ? `wss://${request.headers.host}/media-stream/${agentId}/${userId}`
      : `wss://${request.headers.host}/media-stream/${agentId}`;
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${websocketUrl}" />
  </Connect>
</Response>`;
    reply.type('text/xml').send(twimlResponse);
  } catch (error) {
    console.error('Error handling incoming call:', error);
    reply.status(500).send('Internal Server Error');
  }
});

fastify.register(async (fastify) => {
  fastify.get('/media-stream/:agentId/:userId?', { websocket: true }, (connection, req) => {
    const agentId = req.params.agentId || 'default';
    let userId = req.params.userId || null;
    console.log(`DEBUG: WebSocket URL: ${req.url}`);
    console.log(`DEBUG: URL params - agentId: ${agentId}, userId: ${userId}`);
    let agentConfig = getUserAgent(userId, agentId);
    console.log(`=== WEBSOCKET CONNECTION ===`);
    console.log(`Client connected for agent: ${agentId} (user: ${userId || 'global'})`);
    console.log(`Using agent: ${agentConfig.name}`);
    console.log(`System prompt: ${agentConfig.systemMessage.substring(0, 100)}...`);
    console.log(`============================`);
    let streamSid = null;
    let callId = null;
    let twilioCallSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let conversationWs = null;
    let transcriptionWs = null;
    const connectionData = { connection, conversationWs: null, transcriptionWs: null, agentId };
    try {
      conversationWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        timeout: 30000
      });
      transcriptionWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        },
        timeout: 30000
      });
      connectionData.conversationWs = conversationWs;
      connectionData.transcriptionWs = transcriptionWs;
      activeConnections.add(connectionData);
    } catch (error) {
      console.error('Failed to create OpenAI WebSockets:', error);
      connection.close();
      return;
    }
    const initializeSession = () => {
      console.log('=== INITIALIZING CONVERSATION SESSION ===');
      console.log('Agent ID:', agentId);
      console.log('User ID:', userId || 'global');
      console.log('Using SYSTEM_MESSAGE for USER:', userId || 'global');
      console.log('System Message Preview:', agentConfig.systemMessage.substring(0, 150) + '...');
      console.log('==========================================');
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: "gpt-realtime",
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: {
                type: "server_vad",
                threshold: 0.55,
                prefix_padding_ms: 400,
                silence_duration_ms: 700
              }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: 'marin'
            },
          },
          instructions: agentConfig.systemMessage,
          tools: [
            {
              type: "function",
              name: "end_call",
              description: "Ends the current phone call. Use this when the user says goodbye, indicates they're done, or asks to hang up.",
              parameters: {
                type: "object",
                properties: {
                  reason: { type: "string", description: "Brief reason for ending the call (e.g., 'user requested', 'conversation complete', 'goodbye')" }
                },
                required: ["reason"]
              }
            },
            {
              type: "function",
              name: "save_contact",
              description: "Save contact information to database. Call this immediately after collecting first name, last name, and phone number from the caller.",
              parameters: {
                type: "object",
                properties: {
                  firstName: { type: "string", description: "Caller's first name" },
                  lastName: { type: "string", description: "Caller's last name" },
                  phoneNumber: { type: "string", description: "Caller's phone number including country code" },
                  email: { type: "string", description: "Caller's email address" },
                  callerType: { type: "string", description: "Type: 'new_client', 'existing_client', or 'other'" },
                  notes: { type: "string", description: "Brief case description or reason for calling" }
                },
                required: ["firstName", "lastName", "phoneNumber"]
              }
            }
          ],
          tool_choice: "auto"
        },
      };
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        conversationWs.send(JSON.stringify(sessionUpdate));
      }
    };
    const initializeTranscriptionSession = () => {
      console.log('=== INITIALIZING TRANSCRIPTION SESSION ===');
      const transcriptionSessionUpdate = {
        type: 'session.update',
        session: {
          input_audio_transcription: {
            enabled: true,
            model: 'whisper-1'
          }
        }
      };
      if (transcriptionWs && transcriptionWs.readyState === WebSocket.OPEN) {
        transcriptionWs.send(JSON.stringify(transcriptionSessionUpdate));
      }
    };
    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Say this exact greeting to the caller: "${agentConfig.greetingMessage}"`
            }
          ]
        }
      };
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        conversationWs.send(JSON.stringify(initialConversationItem));
        conversationWs.send(JSON.stringify({ type: 'response.create' }));
      }
    };
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (lastAssistantItem && conversationWs && conversationWs.readyState === WebSocket.OPEN) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          conversationWs.send(JSON.stringify(truncateEvent));
        }
        if (connection.readyState === WebSocket.OPEN) {
          connection.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
        }
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };
    const sendMark = (connection, streamSid) => {
      if (streamSid && connection.readyState === WebSocket.OPEN) {
        const markEvent = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('responsePart');
      }
    };
    conversationWs.on('open', () => {
      console.log('Connected to OpenAI Conversation API');
      setTimeout(initializeSession, 100);
      if (agentConfig.speaksFirst === 'ai') {
        setTimeout(sendInitialConversationItem, 200);
      }
    });
    conversationWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Conversation event: ${response.type}`, response);
        }
        if (response.type === 'response.done' && response.response.status === 'failed') {
          console.log('=== CONVERSATION RESPONSE FAILURE ===');
          console.log('Full response object:', JSON.stringify(response.response, null, 2));
          console.log('====================================');
        }
        if (response.type === 'response.function_call_arguments.done') {
          console.log('🔔 Function call detected:', response);
          if (response.name === 'end_call') {
            const args = JSON.parse(response.arguments);
            console.log(`📞 END_CALL function triggered. Reason: ${args.reason}`);
            if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
              conversationWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: response.call_id,
                  output: JSON.stringify({ success: true, message: 'Call will be terminated' })
                }
              }));
              conversationWs.send(JSON.stringify({ type: 'response.create' }));
            }
            setTimeout(async () => {
              if (twilioCallSid) {
                console.log(`🔚 Ending Twilio call ${twilioCallSid}`);
                await endTwilioCall(twilioCallSid, args.reason);
              } else {
                console.warn('⚠️ No Twilio CallSid available to end call');
              }
              if (connection.readyState === WebSocket.OPEN) {
                connection.close();
              }
            }, 3000);
          }
          if (response.name === 'save_contact') {
            const args = JSON.parse(response.arguments);
            console.log(`📇 SAVE_CONTACT function triggered:`, args);
            (async () => {
              try {
                const fetchResponse = await fetch(
                  'https://mxavpgblepptefeuodvg.supabase.co/functions/v1/create-contact',
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14YXZwZ2JsZXBwdGVmZXVvZHZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgyMjE0ODYsImV4cCI6MjA3Mzc5NzQ4Nn0.ZttgxbiJr0DK-Cr-E99reFPwWhX5CtnNu7BIeykOAEo'
                    },
                    body: JSON.stringify({
                      agentId: agentId,
                      firstName: args.firstName,
                      lastName: args.lastName,
                      phoneNumber: args.phoneNumber,
                      email: args.email || null,
                      tags: ['voice-call'],
                      notes: args.notes || null,
                      callId: callId,
                      userId: userId
                    })
                  }
                );
                const result = await fetchResponse.json();
                let functionOutput;
                if (!fetchResponse.ok) {
                  console.error('Failed to save contact:', result);
                  functionOutput = { success: false, message: 'Contact info noted, will be saved manually' };
                } else {
                  console.log(`✅ Contact saved: ${args.firstName} ${args.lastName}`);
                  functionOutput = { success: true, message: `Contact saved for ${args.firstName} ${args.lastName}` };
                }
                if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
                  conversationWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                      type: 'function_call_output',
                      call_id: response.call_id,
                      output: JSON.stringify(functionOutput)
                    }
                  }));
                  conversationWs.send(JSON.stringify({ type: 'response.create' }));
                }
              } catch (error) {
                console.error('Error saving contact:', error);
                if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
                  conversationWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                      type: 'function_call_output',
                      call_id: response.call_id,
                      output: JSON.stringify({ success: false, message: 'Recording contact information' })
                    }
                  }));
                  conversationWs.send(JSON.stringify({ type: 'response.create' }));
                }
              }
            })();
          }
        }
        if (response.type === 'response.output_audio.delta' && response.delta) {
          if (connection.readyState === WebSocket.OPEN) {
            const audioDelta = {
              event: 'media',
              streamSid: streamSid,
              media: { payload: response.delta }
            };
            connection.send(JSON.stringify(audioDelta));
            if (!responseStartTimestampTwilio) {
              responseStartTimestampTwilio = latestMediaTimestamp;
            }
            if (response.item_id) {
              lastAssistantItem = response.item_id;
            }
            sendMark(connection, streamSid);
          }
        }
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error('Error processing conversation message:', error);
      }
    });
    transcriptionWs.on('open', () => {
      console.log('Connected to OpenAI Transcription API');
      setTimeout(initializeTranscriptionSession, 200);
    });
    transcriptionWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        console.log(`📝 Transcription event: ${response.type}`);
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          const transcriptEntry = {
            id: response.item_id,
            timestamp: new Date().toISOString(),
            speaker: 'caller',
            text: response.transcript,
            confidence: calculateConfidence(response.logprobs)
          };
          console.log(`📝 Transcript completed: ${response.transcript}`);
          if (callId) {
            saveTranscriptEntry(callId, transcriptEntry);
          }
        }
        if (response.type === 'conversation.item.input_audio_transcription.delta') {
          console.log(`📝 Transcript delta: ${response.delta}`);
        }
      } catch (error) {
        console.error('Error processing transcription message:', error);
      }
    });
    connection.on('message', (message) => {
      try {
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
            if (transcriptionWs && transcriptionWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              transcriptionWs.send(JSON.stringify(audioAppend));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            callId = generateCallId();
            twilioCallSid = data.start.callSid;
            ACTIVE_CALL_SIDS[callId] = twilioCallSid;
            console.log(`📞 Call started - Agent: ${agentConfig.name}, Stream: ${streamSid}, Call: ${callId}, Twilio SID: ${twilioCallSid}, User: ${userId || 'global'}`);
            createCallRecord(callId, streamSid, agentId, data.start.callerNumber, userId);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
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
    connection.on('close', () => {
      console.log(`Client disconnected from media stream (user: ${userId || 'global'})`);
      if (callId) {
        const transcriptCount = TRANSCRIPT_STORAGE[callId]?.length || 0;
        updateCallRecord(callId, {
          status: 'completed',
          endTime: new Date().toISOString(),
          hasTranscript: transcriptCount > 0
        });
        delete ACTIVE_CALL_SIDS[callId];
        console.log(`📞 Call ended: ${callId} - ${transcriptCount} transcript entries (user: ${userId || 'global'})`);
      }
      activeConnections.delete(connectionData);
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        conversationWs.close();
      }
      if (transcriptionWs && transcriptionWs.readyState === WebSocket.OPEN) {
        transcriptionWs.close();
      }
    });
    connection.on('error', (error) => {
      console.error('WebSocket connection error:', error);
    });
    conversationWs.on('close', (code, reason) => {
      console.log(`Disconnected from OpenAI Conversation API. Code: ${code}, Reason: ${reason}`);
    });
    conversationWs.on('error', (error) => {
      console.error('Error in Conversation WebSocket:', error);
    });
    transcriptionWs.on('close', (code, reason) => {
      console.log(`Disconnected from OpenAI Transcription API. Code: ${code}, Reason: ${reason}`);
    });
    transcriptionWs.on('error', (error) => {
      console.error('Error in Transcription WebSocket:', error);
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
    console.log('✅ Voice conversation system: ACTIVE');
    console.log('✅ Real-time transcription: ACTIVE');
    console.log('✅ Dashboard APIs: ACTIVE');
    console.log('✅ Multi-user support: ACTIVE');
    console.log('✅ User data isolation: ACTIVE');
    console.log('✅ Lovable sync endpoint: ACTIVE');
    console.log('✅ Speaking order endpoint: ACTIVE');
    console.log('✅ Contact management: ACTIVE');
    console.log('✅ End call function: ACTIVE');
    console.log('✅ Save contact function: ACTIVE (Direct HTTP)');
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

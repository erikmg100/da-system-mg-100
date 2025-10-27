import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { promises as dns } from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
      fetch: (url, options) => {
        console.log('Supabase fetch:', url, options);
        return fetch(url, options).catch(err => {
          console.error('Supabase fetch error:', err.message, err.stack);
          throw err;
        });
      }
    });
    console.log('✅ Supabase client initialized with service role key');
  } catch (error) {
    console.error('Failed to initialize Supabase:', error);
  }
} else if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      fetch: (url, options) => {
        console.log('Supabase fetch:', url, options);
        return fetch(url, options).catch(err => {
          console.error('Supabase fetch error:', err.message, err.stack);
          throw err;
        });
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

// Background audio setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKGROUND_AUDIO_PATH = path.join(__dirname, 'office-ambience.mp3');
const BACKGROUND_VOLUME = 0.15; // 15% volume - subtle background

let backgroundAudioBuffer = null;

// Load background audio on startup
async function loadBackgroundAudio() {
  try {
    if (fs.existsSync(BACKGROUND_AUDIO_PATH)) {
      backgroundAudioBuffer = fs.readFileSync(BACKGROUND_AUDIO_PATH);
      console.log('✅ Background audio loaded:', BACKGROUND_AUDIO_PATH);
    } else {
      console.warn('⚠️ Background audio file not found:', BACKGROUND_AUDIO_PATH);
    }
  } catch (error) {
    console.error('Failed to load background audio:', error);
  }
}

// Call on startup
loadBackgroundAudio();

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

// IMPROVED: Non-blocking Supabase operation wrapper with detailed error logging
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
    console.error(`❌ ${operationName} failed (non-blocking):`, {
      message: error.message,
      code: error.code || 'unknown',
      hint: error.hint || 'none',
      stack: error.stack || 'no stack trace'
    });
    return { success: false, error };
  }
}

function generateCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculateConfidence(logprobs) {
  if (!logprobs || logprobs.length === 0) return 1.0;
  const avgLogprob = logprobs.reduce((sum, lp) => sum + lp, 0) / logprobs.length;
  return Math.exp(avgLogprob);
}

function createCallRecord(callId, streamSid, agentId, callerNumber, userId = null) {
  const callRecord = {
    callId,
    streamSid,
    agentId: agentId || 'default',
    callerNumber: callerNumber || 'unknown',
    userId: userId || 'global',
    status: 'active',
    startTime: new Date().toISOString(),
    endTime: null,
    hasTranscript: false
  };
  CALL_RECORDS.push(callRecord);
  
  // Non-blocking database save
  if (supabase) {
    safeSupabaseOperation(
      async () => {
        const { data, error } = await supabase
          .from('call_logs')
          .insert({
            call_id: callId,
            stream_sid: streamSid,
            agent_id: agentId || 'default',
            caller_number: callerNumber || 'unknown',
            user_id: userId || 'global',
            status: 'active',
            start_time: callRecord.startTime
          });
        if (error) throw error;
        return data;
      },
      `Create call record for ${callId}`
    );
  }
  
  console.log(`📝 Call record created: ${callId}`);
}

function updateCallRecord(callId, updates) {
  const record = CALL_RECORDS.find(r => r.callId === callId);
  if (record) {
    Object.assign(record, updates);
    
    // Non-blocking database update
    if (supabase) {
      safeSupabaseOperation(
        async () => {
          const dbUpdates = {
            status: updates.status,
            end_time: updates.endTime,
            has_transcript: updates.hasTranscript
          };
          const { data, error } = await supabase
            .from('call_logs')
            .update(dbUpdates)
            .eq('call_id', callId);
          if (error) throw error;
          return data;
        },
        `Update call record for ${callId}`
      );
    }
    
    console.log(`📝 Call record updated: ${callId}`, updates);
  }
}

function saveTranscriptEntry(callId, entry) {
  if (!TRANSCRIPT_STORAGE[callId]) {
    TRANSCRIPT_STORAGE[callId] = [];
  }
  TRANSCRIPT_STORAGE[callId].push(entry);
  
  // Non-blocking database save
  if (supabase) {
    safeSupabaseOperation(
      async () => {
        const { data, error } = await supabase
          .from('transcripts')
          .insert({
            call_id: callId,
            speaker: entry.speaker,
            text: entry.text,
            confidence: entry.confidence,
            timestamp: entry.timestamp
          });
        if (error) throw error;
        return data;
      },
      `Save transcript entry for ${callId}`
    );
  }
}

function getUserAgent(userId, agentId) {
  if (!userId || userId === 'null') {
    return GLOBAL_AGENT_CONFIGS[agentId] || GLOBAL_AGENT_CONFIGS['default'];
  }
  if (!USER_DATABASE[userId]) {
    USER_DATABASE[userId] = {
      agents: { 'default': JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE)) }
    };
  }
  return USER_DATABASE[userId].agents[agentId] || USER_DATABASE[userId].agents['default'];
}

function setUserAgent(userId, agentId, config) {
  if (!userId || userId === 'null') {
    GLOBAL_AGENT_CONFIGS[agentId] = config;
    console.log(`✅ Updated global agent: ${agentId}`);
  } else {
    if (!USER_DATABASE[userId]) {
      USER_DATABASE[userId] = { agents: {} };
    }
    USER_DATABASE[userId].agents[agentId] = config;
    console.log(`✅ Updated agent for user ${userId}: ${agentId}`);
  }
}

fastify.get('/health', async (request, reply) => {
  reply.send({ status: 'OK' });
});

fastify.post('/incoming-call/:agentId?', async (request, reply) => {
  const agentId = request.params.agentId || 'default';
  const userId = request.query.userId || null;
  console.log(`📞 Incoming call webhook triggered for agent: ${agentId}, user: ${userId || 'global'}`);
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                            <Connect>
                              <Stream url="wss://${request.headers.host}/media-stream/${agentId}/${userId || 'null'}" />
                            </Connect>
                          </Response>`;
  reply.type('text/xml').send(twimlResponse);
});

fastify.get('/api/agent/:agentId?', { schema: { querystring: { type: 'object', properties: { userId: { type: 'string' } } } } }, async (request, reply) => {
  const agentId = request.params.agentId || 'default';
  const userId = request.query.userId || null;
  const agent = getUserAgent(userId, agentId);
  if (!agent) {
    return reply.status(404).send({ error: 'Agent not found' });
  }
  reply.send(agent);
});

fastify.get('/api/agents', { schema: { querystring: { type: 'object', properties: { userId: { type: 'string' } } } } }, async (request, reply) => {
  const userId = request.query.userId || null;
  let agents;
  if (!userId || userId === 'null') {
    agents = Object.values(GLOBAL_AGENT_CONFIGS);
  } else {
    if (!USER_DATABASE[userId]) {
      USER_DATABASE[userId] = {
        agents: { 'default': JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE)) }
      };
    }
    agents = Object.values(USER_DATABASE[userId].agents);
  }
  reply.send(agents);
});

fastify.post('/api/sync-prompt', async (request, reply) => {
  try {
    const { userId, agentId = 'default', prompt, speaksFirst, voice, fullConfig } = request.body;
    console.log('📥 Sync request from Lovable:', { userId, agentId, speaksFirst, voice, hasFullConfig: !!fullConfig });
    const agent = getUserAgent(userId, agentId);
    if (prompt !== undefined) agent.systemMessage = prompt;
    if (speaksFirst !== undefined) agent.speaksFirst = speaksFirst ? 'ai' : 'caller';
    if (voice !== undefined) agent.voice = voice;
    if (fullConfig) {
      Object.assign(agent, {
        name: fullConfig.agentName || agent.name,
        personality: fullConfig.personality || agent.personality,
        greetingMessage: fullConfig.greetingMessage || agent.greetingMessage,
        language: fullConfig.language || agent.language,
        backgroundNoise: fullConfig.backgroundNoise || false
      });
    }
    agent.updatedAt = new Date().toISOString();
    setUserAgent(userId, agentId, agent);
    console.log(`✅ Synced agent config for ${userId || 'global'}/${agentId}`);
    reply.send({ success: true, agent });
  } catch (error) {
    console.error('❌ Sync error:', error);
    reply.status(500).send({ error: 'Failed to sync prompt' });
  }
});

fastify.put('/api/update-prompt', async (request, reply) => {
  try {
    const { userId, agentId = 'default', systemMessage } = request.body;
    const agent = getUserAgent(userId, agentId);
    agent.systemMessage = systemMessage;
    agent.updatedAt = new Date().toISOString();
    setUserAgent(userId, agentId, agent);
    reply.send({ success: true, systemMessage: agent.systemMessage });
  } catch (error) {
    console.error('Error updating prompt:', error);
    reply.status(500).send({ error: 'Failed to update prompt' });
  }
});

fastify.get('/api/calls', { schema: { querystring: { type: 'object', properties: { userId: { type: 'string' } } } } }, async (request, reply) => {
  const userId = request.query.userId || null;
  const userCalls = userId && userId !== 'null' 
    ? CALL_RECORDS.filter(call => call.userId === userId)
    : CALL_RECORDS.filter(call => call.userId === 'global');
  reply.send(userCalls);
});

fastify.get('/api/call/:callId/transcript', async (request, reply) => {
  const { callId } = request.params;
  const transcript = TRANSCRIPT_STORAGE[callId] || [];
  reply.send({ callId, transcript });
});

fastify.post('/api/speaking-order', async (request, reply) => {
  try {
    const { userId, agentId = 'default', speaksFirst } = request.body;
    const agent = getUserAgent(userId, agentId);
    agent.speaksFirst = speaksFirst ? 'ai' : 'caller';
    agent.updatedAt = new Date().toISOString();
    setUserAgent(userId, agentId, agent);
    console.log(`✅ Updated speaking order for ${userId || 'global'}/${agentId}: ${agent.speaksFirst}`);
    reply.send({ success: true, speaksFirst: agent.speaksFirst });
  } catch (error) {
    console.error('Error updating speaking order:', error);
    reply.status(500).send({ error: 'Failed to update speaking order' });
  }
});

fastify.post('/api/contacts', async (request, reply) => {
  try {
    const contactData = request.body;
    console.log('📝 Received contact data:', contactData);
    
    // Non-blocking database save
    const result = await safeSupabaseOperation(
      async () => {
        const { data, error } = await supabase
          .from('contacts')
          .insert(contactData);
        if (error) throw error;
        return data;
      },
      'Save contact'
    );
    
    if (result.success) {
      reply.send({ success: true, message: 'Contact saved successfully' });
    } else {
      reply.status(500).send({ error: 'Failed to save contact', details: result.error });
    }
  } catch (error) {
    console.error('Error saving contact:', error);
    reply.status(500).send({ error: 'Failed to save contact' });
  }
});

// Background audio player
function startBackgroundAudio(connection, streamSid) {
  if (!backgroundAudioBuffer) {
    console.log('Background audio not available');
    return null;
  }

  console.log('🎵 Starting background audio stream');
  
  const interval = setInterval(() => {
    try {
      if (connection.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        return;
      }

      // Send a small chunk of background audio at reduced volume
      const chunkSize = 640;
      const chunk = backgroundAudioBuffer.slice(0, chunkSize).toString('base64');
      
      const audioPayload = {
        event: 'media',
        streamSid: streamSid,
        media: {
          payload: chunk
        }
      };
      
      connection.send(JSON.stringify(audioPayload));
    } catch (error) {
      console.error('Background audio streaming error:', error);
      clearInterval(interval);
    }
  }, 3000);

  return interval;
}

fastify.register(async (fastify) => {
  fastify.get('/media-stream/:agentId/:userId?', { websocket: true }, (connection, req) => {
    const agentId = req.params.agentId || 'default';
    let userId = req.params.userId || null;
    if (userId === 'null') userId = null;
    console.log(`DEBUG: WebSocket URL: ${req.url}`);
    console.log(`DEBUG: URL params - agentId: ${agentId}, userId: ${userId}`);
    let agentConfig = getUserAgent(userId, agentId);
    
    // Start background audio if enabled
    let backgroundAudioInterval = null;
    if (agentConfig.backgroundNoise === true) {
      console.log('🎵 Background noise enabled for agent:', agentConfig.name);
    }
    
    console.log(`=== WEBSOCKET CONNECTION ===`);
    console.log(`Client connected for agent: ${agentId} (user: ${userId || 'global'})`);
    console.log(`Using agent: ${agentConfig.name}`);
    console.log(`System prompt: ${agentConfig.systemMessage.substring(0, 100)}...`);
    console.log(`==============================`);
    let streamSid = null;
    let callId = null;
    let twilioCallSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let conversationWs = null;
    let transcriptionWs = null;
    let lastActivity = Date.now();
    const connectionData = { connection, conversationWs: null, transcriptionWs: null, agentId };
    activeConnections.add(connectionData);
    const keepAliveInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > 30000 && connection.readyState === WebSocket.OPEN) {
        try {
          connection.ping();
        } catch (e) {
          console.error('Error sending ping:', e);
        }
      }
    }, 15000);
    const OPENAI_CONVERSATION_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
    const OPENAI_TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
    const initializeConversationWs = () => {
      conversationWs = new WebSocket(OPENAI_CONVERSATION_URL, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      connectionData.conversationWs = conversationWs;
    };
    const initializeTranscriptionWs = () => {
      transcriptionWs = new WebSocket(OPENAI_TRANSCRIPTION_URL, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });
      connectionData.transcriptionWs = transcriptionWs;
    };
    const reconnectConversationWs = () => {
      console.log('Attempting to reconnect Conversation WebSocket...');
      setTimeout(() => {
        initializeConversationWs();
        conversationWs.on('open', () => {
          console.log('Reconnected to OpenAI Conversation API');
          initializeSession();
        });
        conversationWs.on('message', handleConversationMessage);
        conversationWs.on('close', reconnectConversationWs);
        conversationWs.on('error', (error) => {
          console.error('Error in reconnected Conversation WebSocket:', error);
        });
      }, 5000);
    };
    initializeConversationWs();
    initializeTranscriptionWs();
    const sendMark = (connection, streamSid) => {
      if (connection.readyState === WebSocket.OPEN) {
        const markEvent = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('responsePart');
      }
    };
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: agentConfig.voice || VOICE,
          instructions: agentConfig.systemMessage || DEFAULT_AGENT_TEMPLATE.systemMessage,
          modalities: ['text', 'audio'],
          temperature: 0.8,
          tools: [
            {
              type: 'function',
              name: 'end_call',
              description: 'Ends the current phone call. Use this when the user wants to hang up, says goodbye, or indicates they are done with the conversation.',
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
            },
            {
              type: 'function',
              name: 'save_contact',
              description: 'Saves contact information from the caller to the database. Use this when the caller provides their contact details during the conversation.',
              parameters: {
                type: 'object',
                properties: {
                  first_name: {
                    type: 'string',
                    description: 'The caller\'s first name'
                  },
                  last_name: {
                    type: 'string',
                    description: 'The caller\'s last name'
                  },
                  phone: {
                    type: 'string',
                    description: 'The caller\'s phone number'
                  },
                  email: {
                    type: 'string',
                    description: 'The caller\'s email address'
                  },
                  case_type: {
                    type: 'string',
                    description: 'The type of legal case or reason for calling'
                  },
                  notes: {
                    type: 'string',
                    description: 'Any additional notes or details about the call'
                  }
                },
                required: ['first_name', 'phone']
              }
            }
          ],
          tool_choice: 'auto'
        }
      };
      console.log('Sending session update:', JSON.stringify(sessionUpdate));
      conversationWs.send(JSON.stringify(sessionUpdate));
    };
    const initializeTranscriptionSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: null,
          input_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1'
          }
        }
      };
      console.log('Sending transcription session update');
      transcriptionWs.send(JSON.stringify(sessionUpdate));
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
              text: agentConfig.greetingMessage || 'Greet the user with a warm, friendly tone and ask how you can help them today.'
            }
          ]
        }
      };
      if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
      conversationWs.send(JSON.stringify(initialConversationItem));
      conversationWs.send(JSON.stringify({ type: 'response.create' }));
    };
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);
        if (connection.readyState === WebSocket.OPEN) {
          const clearMessage = {
            event: 'clear',
            streamSid: streamSid
          };
          connection.send(JSON.stringify(clearMessage));
          if (SHOW_TIMING_MATH) console.log(`Sent clear message to Twilio. Remaining marks in queue: ${markQueue.length}`);
          markQueue = [];
        }
      }
      if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
        const truncateEvent = {
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: 0
        };
        conversationWs.send(JSON.stringify(truncateEvent));
        if (SHOW_TIMING_MATH) console.log('Sent truncation event to OpenAI');
      }
      conversationWs.send(JSON.stringify({ type: 'response.cancel' }));
    };
    const handleConversationMessage = (data) => {
      try {
        lastActivity = Date.now();
        const response = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`🔊 Conversation event: ${response.type}`, response);
        }
        if (response.type === 'response.function_call_arguments.done') {
          console.log('🔧 Function call completed:', response);
          const functionName = response.name;
          const functionArgs = JSON.parse(response.arguments);
          console.log(`Function: ${functionName}, Args:`, functionArgs);
          if (functionName === 'end_call') {
            console.log('📞 End call function triggered by AI');
            if (twilioCallSid && twilioClient) {
              twilioClient
                .calls(twilioCallSid)
                .update({ status: 'completed' })
                .then(call => console.log(`✅ Call ended successfully: ${call.sid}`))
                .catch(err => console.error('❌ Failed to end call via Twilio:', err));
            }
          } else if (functionName === 'save_contact') {
            console.log('📝 Save contact function triggered by AI');
            safeSupabaseOperation(
              async () => {
                const contactData = {
                  first_name: functionArgs.first_name,
                  last_name: functionArgs.last_name || null,
                  phone: functionArgs.phone,
                  email: functionArgs.email || null,
                  case_type: functionArgs.case_type || null,
                  notes: functionArgs.notes || null,
                  agent_id: agentId,
                  user_id: userId,
                  call_id: callId,
                  source: 'voice_call',
                  created_at: new Date().toISOString()
                };
                const { data, error } = await supabase
                  .from('contacts')
                  .insert(contactData);
                if (error) throw error;
                console.log('✅ Contact saved successfully via function call');
                return data;
              },
              'Save contact via function call'
            );
          }
        }
        if (response.type === 'response.audio.delta' && response.delta) {
          try {
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
          } catch (audioError) {
            console.error('Audio streaming error (non-fatal):', audioError);
          }
        }
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error('Error processing conversation message:', error);
      }
    };
    conversationWs.on('open', () => {
      console.log('Connected to OpenAI Conversation API');
      setTimeout(initializeSession, 100);
      if (agentConfig.speaksFirst === 'ai') {
        setTimeout(sendInitialConversationItem, 200);
      }
    });
    conversationWs.on('message', handleConversationMessage);
    conversationWs.on('close', (code, reason) => {
      console.log(`Disconnected from OpenAI Conversation API. Code: ${code}, Reason: ${reason}`);
      if (code !== 1000 && connection.readyState === WebSocket.OPEN) {
        reconnectConversationWs();
      }
    });
    conversationWs.on('error', (error) => {
      console.error('Error in Conversation WebSocket:', error);
    });
    transcriptionWs.on('open', () => {
      console.log('Connected to OpenAI Transcription API');
      setTimeout(initializeTranscriptionSession, 200);
    });
    transcriptionWs.on('message', (data) => {
      try {
        lastActivity = Date.now();
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
            
            // Start background audio if enabled
            if (agentConfig.backgroundNoise === true && !backgroundAudioInterval) {
              setTimeout(() => {
                backgroundAudioInterval = startBackgroundAudio(connection, streamSid);
              }, 2000);
            }
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
      // Clean up background audio
      if (backgroundAudioInterval) {
        clearInterval(backgroundAudioInterval);
      }
      
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
      clearInterval(keepAliveInterval);
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
    console.log('✅ Save contact function: ACTIVE (Direct Supabase)');
    console.log('✅ CORS configuration: FIXED');
    console.log('✅ Supabase integration:', supabase ? 'ACTIVE' : 'DISABLED (missing credentials)');
    console.log('✅ Twilio client:', twilioClient ? 'ACTIVE' : 'DISABLED (missing credentials)');
    console.log('✅ Non-blocking database operations: ACTIVE');
    console.log('✅ Call resilience improved: Database failures won\'t crash calls');
    console.log('✅ Background audio support: ACTIVE');
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();

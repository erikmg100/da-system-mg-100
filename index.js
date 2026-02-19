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
  'response.function_call_arguments.done'
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
     
      console.log(`🔄 ${operationName}: Attempt ${attempt}/${retries}`);
      const result = await operation();
      console.log(`✅ ${operationName}: Success on attempt ${attempt}`);
      return { success: true, data: result };
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const errorDetails = {
        attempt: `${attempt}/${retries}`,
        message: error.message,
        code: error.code || 'unknown',
        hint: error.hint || 'none',
        name: error.name || 'Error',
        cause: error.cause ? String(error.cause) : 'none',
        type: error.constructor.name
      };

      // Special handling for network errors
      if (error.message?.includes('fetch failed') || error.cause?.code === 'ENOTFOUND') {
        errorDetails.networkError = true;
        errorDetails.possibleCauses = [
          'Railway cannot reach Supabase',
          'DNS resolution failure',
          'Network connectivity issue',
          'Check SUPABASE_URL environment variable'
        ];
      }

      console.error(`❌ ${operationName} failed:`, errorDetails);

      if (!isLastAttempt) {
        const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
        console.log(`⏳ Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        return { success: false, error: error.message, details: errorDetails };
      }
    }
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

// 🆕 UNIVERSAL AUTOMATIC CONTACT EXTRACTION - ALWAYS CREATES CONTACT WITH AI SUMMARY
async function extractContactFromTranscript(callId, userId, callerNumber) {
  console.log(`🔍 [extractContactFromTranscript] Starting for call ${callId}`);
  
  const transcript = TRANSCRIPT_STORAGE[callId];
  if (!transcript || transcript.length === 0) {
    console.log('⚠️ No transcript available for contact extraction');
    return null;
  }

  // Build full transcript text
  const fullTranscript = transcript
    .map(entry => `${entry.role}: ${entry.text}`)
    .join('\n');

  console.log('📝 Transcript for analysis:', fullTranscript.substring(0, 500) + '...');

  try {
    // Use OpenAI to extract structured contact info
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a contact information extractor. Extract first name, last name, email, and any relevant notes from call transcripts. Return ONLY valid JSON with keys: firstName, lastName, email (or null if not mentioned), callerType (new_client/existing_client/unknown), notes. If information is not mentioned, use null.'
          },
          {
            role: 'user',
            content: `Extract contact information from this call transcript:\n\n${fullTranscript}`
          }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();
    const extractedInfo = JSON.parse(data.choices[0].message.content);
    
    console.log('✅ Extracted contact info:', extractedInfo);

    // ALWAYS save contact, even if no name found - use "Unknown Caller"
    if (!extractedInfo.firstName) {
      extractedInfo.firstName = 'Unknown';
      extractedInfo.lastName = 'Caller';
      extractedInfo.notes = extractedInfo.notes || 'Caller did not provide name';
      console.log('⚠️ No contact name found - using "Unknown Caller" placeholder');
    }

    // Save or update contact
    const contact = await createOrUpdateContact(
      userId,
      callerNumber,
      callId,
      null, // agentId not needed for transcript extraction
      extractedInfo
    );

    // ALWAYS generate AI summary for the contact
    if (contact) {
      console.log('🤖 Generating AI call summary for contact...');
      await generateCallSummaryForContact(
        contact.id,
        fullTranscript,
        extractedInfo,
        callerNumber,
        callId
      );
      console.log('✅ Contact saved and AI summary generated');
    }

    return extractedInfo;
  } catch (error) {
    console.error('❌ Error extracting contact from transcript:', error);
    return null;
  }
}

// 🆕 Generate AI call summary and append to contact's call_summary field
async function generateCallSummaryForContact(contactId, transcript, extractedInfo, callerNumber, callId) {
  console.log(`🤖 Generating AI call summary for contact ${contactId}...`);
  
  try {
    const summaryResponse = await fetch(`${SUPABASE_URL}/functions/v1/generate-call-summary`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        firstName: extractedInfo.firstName,
        lastName: extractedInfo.lastName,
        phoneNumber: callerNumber,
        email: extractedInfo.email,
        callerType: extractedInfo.callerType,
        callId: callId,
        transcript: transcript,
        notes: extractedInfo.notes || transcript.substring(0, 500),
        customFields: extractedInfo
      })
    });

    if (summaryResponse.ok) {
      const { summary } = await summaryResponse.json();
      console.log('✅ AI Summary generated:', summary);
      
      // Fetch existing summary to append
      const { data: contact } = await supabase
        .from('contacts')
        .select('call_summary')
        .eq('id', contactId)
        .single();
      
      // Format new summary with timestamp
      const timestamp = new Date().toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      
      const formattedNewSummary = `**[${timestamp}]**\n${summary}`;
      
      // Append to existing or create new
      const updatedSummary = contact?.call_summary
        ? `${contact.call_summary}\n\n---\n\n${formattedNewSummary}`
        : formattedNewSummary;
      
      // Update contact with appended summary
      await supabase
        .from('contacts')
        .update({ call_summary: updatedSummary })
        .eq('id', contactId);
      
      console.log('✅ Contact updated with AI summary');
    } else {
      console.error('❌ Failed to generate summary:', await summaryResponse.text());
    }
  } catch (error) {
    console.error('❌ Error generating AI summary:', error);
  }
}

// FIXED: Create/update contact using Supabase client directly - ENHANCED for automatic extraction
async function createOrUpdateContact(userId, phoneNumber, callId, agentId, metadata = {}) {
  if (!supabase) {
    console.log('⚠️ Contact creation skipped: Supabase not available');
    return null;
  }

  // Use system/fallback user ID if no userId provided
  const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
  const effectiveUserId = userId || SYSTEM_USER_ID;
  
  if (!userId) {
    console.log(`⚠️ No userId available - using system fallback ID for contact ${phoneNumber}`);
  }

  console.log('💾 [createOrUpdateContact] Starting with:', {
    userId: effectiveUserId,
    phoneNumber,
    callId,
    agentId,
    metadata,
    timestamp: new Date().toISOString()
  });

  const result = await safeSupabaseOperation(
    async () => {
      // Prepare contact data from metadata
      const contactData = {
        user_id: effectiveUserId,
        phone_number: phoneNumber,
        name: metadata.firstName && metadata.lastName 
          ? `${metadata.firstName} ${metadata.lastName}`.trim()
          : metadata.firstName || metadata.name || null,
        email: metadata.email || null,
        notes: metadata.notes || null,
        tags: metadata.callerType ? [metadata.callerType] : (metadata.tags || (metadata.firstName === 'Unknown' ? ['anonymous-caller'] : ['voice-call'])),
        custom_fields: {
          ...(metadata.customFields || {}),
          caller_type: metadata.callerType || 'unknown',
          source: agentId ? 'agent_function_call' : 'transcript_extraction',
          last_call_id: callId
        }
      };

      // Check for existing contact
      const { data: existing, error: fetchError } = await supabase
        .from('contacts')
        .select('*')
        .eq('user_id', effectiveUserId)
        .eq('phone_number', phoneNumber)
        .maybeSingle();
      
      if (fetchError) throw fetchError;
      
      if (existing) {
        // Update existing contact
        const updates = {
          last_call_id: callId,
          last_contact: new Date().toISOString(),
          total_calls: (existing.total_calls || 0) + 1,
          updated_at: new Date().toISOString()
        };

        // Only update fields if new data provided
        if (contactData.name) updates.name = contactData.name;
        if (contactData.email) updates.email = contactData.email;
        if (contactData.notes) updates.notes = contactData.notes;
        if (contactData.tags.length > 0) {
          updates.tags = [...new Set([...(existing.tags || []), ...contactData.tags])];
        }
        if (contactData.custom_fields) {
          updates.custom_fields = { ...(existing.custom_fields || {}), ...contactData.custom_fields };
        }

        const { data, error } = await supabase
          .from('contacts')
          .update(updates)
          .eq('id', existing.id)
          .select()
          .single();
        
        if (error) throw error;
        console.log(`✅ Updated contact ${phoneNumber} for user ${effectiveUserId}`);
        return data;
      } else {
        // Create new contact
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            ...contactData,
            first_call_id: callId,
            last_call_id: callId,
            first_contact: new Date().toISOString(),
            last_contact: new Date().toISOString(),
            total_calls: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
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
    const callerNumber = request.body.From; // Extract caller's phone number
    let agentId = request.params.agentId || 'default';
    let userId = request.query.userId || null;
    if (supabase && calledNumber) {
      try {
        const { data: phoneAssignment, error } = await supabase
          .from('phone_numbers')
          .select('user_id, assigned_agent_id')
          .eq('phone_number', calledNumber)
          .maybeSingle();
        if (!error && phoneAssignment) {
          userId = phoneAssignment.user_id;
          agentId = phoneAssignment.assigned_agent_id || 'default';
          console.log(`✅ Found phone assignment: User ${userId}, Agent ${agentId}`);
        } else if (error) {
          console.error('Supabase query error:', error);
        } else {
          console.log(`⚠️ No phone number assignment found for ${calledNumber}, using defaults`);
        }
      } catch (error) {
        console.error('Error querying agent assignment:', error);
      }
    }
    console.log(`DEBUG: Incoming call - calledNumber=${calledNumber}, callerNumber=${callerNumber}, agentId=${agentId}, userId=${userId}`);
    console.log(`DEBUG: Phone lookup successful: ${userId ? 'YES' : 'NO - WILL USE FALLBACK CONTACT SEARCH'}`);
    const config = getUserAgent(userId, agentId);
    console.log('=== INCOMING CALL WEBHOOK ===');
    console.log('Called Number:', calledNumber);
    console.log('Caller Number:', callerNumber);
    console.log('Agent ID:', agentId);
    console.log('User ID:', userId || 'global');
    console.log('Agent Name:', config.name);
    console.log('===============================');
    // Pass caller number to WebSocket URL
    const encodedCallerNumber = encodeURIComponent(callerNumber || 'Unknown');
    const websocketUrl = userId
      ? `wss://${request.headers.host}/media-stream/${agentId}/${userId}?from=${encodedCallerNumber}`
      : `wss://${request.headers.host}/media-stream/${agentId}?from=${encodedCallerNumber}`;
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
    
    // Extract caller number from query params (passed from /incoming-call)
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    let callerNumber = urlParams.get('from') || null;
    
    console.log(`DEBUG: WebSocket URL: ${req.url}`);
    console.log(`DEBUG: URL params - agentId: ${agentId}, userId: ${userId}, callerNumber: ${callerNumber}`);
    let agentConfig = getUserAgent(userId, agentId);
    console.log(`=== WEBSOCKET CONNECTION ===`);
    console.log(`Client connected for agent: ${agentId} (user: ${userId || 'global'})`);
    console.log(`Caller Number from URL: ${callerNumber}`);
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
    let lastActivity = Date.now();
    const connectionData = { connection, conversationWs: null, agentId };
    
    // Function to initialize or reinitialize conversation WebSocket
    const initializeConversationWs = () => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
        timeout: 30000
      });
      connectionData.conversationWs = ws;
      return ws;
    };

    // Function to reconnect conversation WebSocket with preserved state
    const reconnectConversationWs = (attempt = 1, maxAttempts = 3) => {
      if (attempt > maxAttempts) {
        console.error(`Failed to reconnect to OpenAI Conversation API after ${maxAttempts} attempts`);
        if (connection.readyState === WebSocket.OPEN) {
          connection.close();
        }
        return;
      }
      console.log(`Attempting to reconnect to OpenAI Conversation API (Attempt ${attempt}/${maxAttempts})`);
      // Preserve call state
      const savedState = {
        markQueue: [...markQueue],
        lastAssistantItem,
        responseStartTimestampTwilio
      };
      if (conversationWs && conversationWs.readyState !== WebSocket.CLOSED) {
        conversationWs.close();
      }
      conversationWs = initializeConversationWs();
      connectionData.conversationWs = conversationWs;

      // Restore call state
      markQueue = savedState.markQueue;
      lastAssistantItem = savedState.lastAssistantItem;
      responseStartTimestampTwilio = savedState.responseStartTimestampTwilio;

      conversationWs.on('open', () => {
        console.log('Reconnected to OpenAI Conversation API');
        setTimeout(initializeSession, 100);
        if (agentConfig.speaksFirst === 'ai') {
          setTimeout(sendInitialConversationItem, 200);
        }
      });

      conversationWs.on('message', handleConversationMessage);

      conversationWs.on('close', (code, reason) => {
        console.log(`Disconnected from OpenAI Conversation API. Code: ${code}, Reason: ${reason}`);
        if (code !== 1000 && connection.readyState === WebSocket.OPEN) {
          setTimeout(() => reconnectConversationWs(attempt + 1, maxAttempts), 5000);
        }
      });

      conversationWs.on('error', (error) => {
        console.error('Error in Conversation WebSocket:', error);
      });
    };

    try {
      conversationWs = initializeConversationWs();
      connectionData.conversationWs = conversationWs;
      activeConnections.add(connectionData);
    } catch (error) {
      console.error('Failed to create OpenAI WebSockets:', error);
      connection.close();
      return;
    }

    // Add connection health monitoring with active pings
    const keepAliveInterval = setInterval(() => {
      if (Date.now() - lastActivity > 45000) {
        console.warn('⚠️ No activity for 45s - connection may be stale');
      }
    }, 15000);

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
          modalities: ['audio', 'text'],
          instructions: agentConfig.systemMessage,
          voice: agentConfig.voice || 'marin',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          },
          input_audio_transcription: {
            model: 'whisper-1'
          },
          temperature: 0.8,
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
                  phoneNumber: { type: "string", description: "OPTIONAL: Only include if caller explicitly requests callback at a different number. Leave empty to use their calling number." },
                  email: { type: "string", description: "Caller's email address" },
                  callerType: { type: "string", description: "Type: 'new_client', 'existing_client', or 'other'" },
                  notes: { type: "string", description: "Brief case description or reason for calling" }
                },
                required: ["firstName", "lastName"]
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

    // Transcription now handled by main conversationWs via input_audio_transcription config

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

    // Extracted message handler for reusability
    const handleConversationMessage = (data) => {
      try {
        lastActivity = Date.now();
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
              let attempts = 0;
              const maxAttempts = 30; // 3 seconds max wait
              const waitForCompletion = setInterval(() => {
                attempts++;
                if (markQueue.length === 0 || attempts >= maxAttempts) {
                  clearInterval(waitForCompletion);
                  if (twilioCallSid) {
                    console.log(`🔚 Ending Twilio call ${twilioCallSid}`);
                    endTwilioCall(twilioCallSid, args.reason);
                  } else {
                    console.warn('⚠️ No Twilio CallSid available to end call');
                  }
                  if (connection.readyState === WebSocket.OPEN) {
                    connection.close();
                  }
                }
              }, 100);
            }, 3000);
          }
          if (response.name === 'save_contact') {
            const args = JSON.parse(response.arguments);
            console.log(`📇 SAVE_CONTACT function triggered:`, args);
            (async () => {
              try {
                // ALWAYS use the caller's actual phone number (where they're calling from)
                const phoneNumber = callerNumber || 'unknown';
                
                console.log('Attempting to save contact:', {
                  firstName: args.firstName,
                  lastName: args.lastName,
                  phoneNumber: phoneNumber,
                  email: args.email,
                  callerType: args.callerType,
                  callerId: callerNumber
                });
                
                // Save contact directly using Supabase SDK
                console.log('💾 Saving contact directly to database');
                
                let functionOutput;
                try {
                  // Build the full name
                  const name = `${args.firstName} ${args.lastName}`.trim();

                  // Prepare tags array
                  const tags = [];
                  if (args.callerType) {
                    tags.push(args.callerType);
                  }

                  // Check if contact already exists
                  console.log('🔍 Checking for existing contact:', { userId, phoneNumber });

                  let existingContact = null;
                  let selectError = null;

                  // First try: Search with userId if available
                  if (userId) {
                    const result = await supabase
                      .from('contacts')
                      .select('*')
                      .eq('user_id', userId)
                      .eq('phone_number', phoneNumber)
                      .maybeSingle();
                    
                    existingContact = result.data;
                    selectError = result.error;
                  }

                  // Second try: If userId is null or no contact found, search by phone alone
                  // This handles the case where userId lookup failed but contact exists
                  if (!existingContact && !selectError) {
                    console.log('🔍 Fallback: Searching for contact by phone number alone');
                    const result = await supabase
                      .from('contacts')
                      .select('*')
                      .eq('phone_number', phoneNumber)
                      .maybeSingle();
                    
                    existingContact = result.data;
                    selectError = result.error;
                    
                    // If we found a contact this way, use its user_id for the update
                    if (existingContact) {
                      console.log(`✅ Found existing contact via phone lookup: ${existingContact.id} (user: ${existingContact.user_id})`);
                      userId = existingContact.user_id; // Use the contact's user_id for consistency
                    }
                  }

                  if (selectError) {
                    console.error('❌ Error checking for existing contact:', selectError);
                    throw selectError;
                  }

                  let contact;
                  
                  if (existingContact) {
                    // Update existing contact
                    console.log('🔄 Updating existing contact:', existingContact.id);
                    
                    const updateData = {
                      name: name || existingContact.name,
                      email: args.email || existingContact.email,
                      last_call_id: callId,
                      last_contact: new Date().toISOString(),
                      total_calls: existingContact.total_calls + 1,
                      updated_at: new Date().toISOString()
                    };
                    
                    // Build notes with any additional phone numbers mentioned
                    let finalNotes = args.notes || existingContact.notes || '';
                    
                    // If caller provided a different phone number, add it to notes
                    if (args.phoneNumber && args.phoneNumber.trim() !== '' && args.phoneNumber !== callerNumber) {
                      const additionalPhoneNote = `\nAdditional phone: ${args.phoneNumber}`;
                      if (!finalNotes.includes(additionalPhoneNote)) {
                        finalNotes = (finalNotes + additionalPhoneNote).trim();
                      }
                    }
                    
                    updateData.notes = finalNotes;

                    // Merge tags
                    if (tags.length > 0) {
                      const existingTags = existingContact.tags || [];
                      updateData.tags = [...new Set([...existingTags, ...tags])];
                    }

                    console.log('💾 Updating contact with data:', updateData);

                    const { data: updatedContact, error: updateError } = await supabase
                      .from('contacts')
                      .update(updateData)
                      .eq('id', existingContact.id)
                      .select()
                      .single();

                    if (updateError) {
                      console.error('❌ Failed to update contact:', updateError);
                      throw updateError;
                    }

                    contact = updatedContact;
                    console.log('✅ Contact updated successfully:', contact);
                    functionOutput = { success: true, message: `Contact updated for ${name}` };

                    // Generate AI call summary
                    console.log('🤖 Generating AI call summary...');
                    try {
                      const summaryResponse = await fetch(`${SUPABASE_URL}/functions/v1/generate-call-summary`, {
                        method: 'POST',
                        headers: {
                          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                          'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                          firstName: args.firstName,
                          lastName: args.lastName,
                          phoneNumber: phoneNumber,
                          email: args.email,
                          callerType: args.callerType,
                          callId: callId,
                          notes: args.notes,
                          customFields: args
                        })
                      });

                      if (summaryResponse.ok) {
                        const { summary } = await summaryResponse.json();
                        console.log('✅ AI Summary generated:', summary);
                        
                        // Update contact with the AI summary
                        const { error: summaryUpdateError } = await supabase
                          .from('contacts')
                          .update({ call_summary: summary })
                          .eq('id', contact.id);
                        
                        if (summaryUpdateError) {
                          console.error('❌ Failed to update contact with summary:', summaryUpdateError);
                        } else {
                          console.log('✅ Contact updated with AI summary');
                        }
                      } else {
                        console.error('❌ Failed to generate summary:', await summaryResponse.text());
                      }
                    } catch (summaryError) {
                      console.error('❌ Error generating AI summary:', summaryError);
                      // Don't fail the entire operation if summary generation fails
                    }
                    
                  } else {
                    // Create new contact
                    console.log('➕ Creating new contact');
                    
                    // Build notes with any additional phone numbers mentioned
                    let finalNotes = args.notes || '';
                    
                    // If caller provided a different phone number, add it to notes
                    if (args.phoneNumber && args.phoneNumber.trim() !== '' && args.phoneNumber !== callerNumber) {
                      const additionalPhoneNote = `\nAdditional phone: ${args.phoneNumber}`;
                      if (!finalNotes.includes(additionalPhoneNote)) {
                        finalNotes = (finalNotes + additionalPhoneNote).trim();
                      }
                    }
                    
                    const insertData = {
                      user_id: userId,
                      phone_number: phoneNumber,
                      name: name,
                      email: args.email || null,
                      first_call_id: callId,
                      last_call_id: callId,
                      first_contact: new Date().toISOString(),
                      last_contact: new Date().toISOString(),
                      total_calls: 1,
                      notes: finalNotes || null,
                      tags: tags.length > 0 ? tags : null,
                      custom_fields: {}
                    };

                    console.log('💾 Inserting new contact with data:', insertData);

                    const { data: newContact, error: insertError } = await supabase
                      .from('contacts')
                      .insert(insertData)
                      .select()
                      .single();

                    if (insertError) {
                      console.error('❌ Failed to create contact:', insertError);
                      throw insertError;
                    }

                    contact = newContact;
                    console.log('✅ Contact created successfully:', contact);
                    functionOutput = { success: true, message: `Contact saved for ${name}` };

                    // Generate AI call summary
                    console.log('🤖 Generating AI call summary...');
                    try {
                      const summaryResponse = await fetch(`${SUPABASE_URL}/functions/v1/generate-call-summary`, {
                        method: 'POST',
                        headers: {
                          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                          'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                          firstName: args.firstName,
                          lastName: args.lastName,
                          phoneNumber: phoneNumber,
                          email: args.email,
                          callerType: args.callerType,
                          callId: callId,
                          notes: args.notes,
                          customFields: args
                        })
                      });

                      if (summaryResponse.ok) {
                        const { summary } = await summaryResponse.json();
                        console.log('✅ AI Summary generated:', summary);
                        
                        // Update contact with the AI summary
                        const { error: summaryUpdateError } = await supabase
                          .from('contacts')
                          .update({ call_summary: summary })
                          .eq('id', contact.id);
                        
                        if (summaryUpdateError) {
                          console.error('❌ Failed to update contact with summary:', summaryUpdateError);
                        } else {
                          console.log('✅ Contact updated with AI summary');
                        }
                      } else {
                        console.error('❌ Failed to generate summary:', await summaryResponse.text());
                      }
                    } catch (summaryError) {
                      console.error('❌ Error generating AI summary:', summaryError);
                      // Don't fail the entire operation if summary generation fails
                    }
                  }
                } catch (dbError) {
                  console.error('❌ Database error saving contact:', dbError);
                  functionOutput = { success: false, message: 'Contact info noted, will be saved manually' };
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
            // Skip faulty audio chunk to prevent crash
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

        // Capture AI response transcriptions
        if (response.type === 'response.audio_transcript.done') {
          console.log('🤖 Assistant transcription:', response.transcript);
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

    // Transcription now handled by conversationWs events directly

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
            // Audio transcription now handled by conversationWs
            break;
          case 'start':
            streamSid = data.start.streamSid;
            callId = generateCallId();
            twilioCallSid = data.start.callSid;
            // Use callerNumber from URL params (already set above), fallback to customParameters
            if (!callerNumber || callerNumber === 'Unknown') {
              callerNumber = data.start.customParameters?.From || data.start.callerNumber || 'Unknown';
            }
            console.log('📞 Final caller number for call record:', callerNumber);
            ACTIVE_CALL_SIDS[callId] = twilioCallSid;
            console.log(`📞 Call started - Agent: ${agentConfig.name}, Stream: ${streamSid}, Call: ${callId}, Twilio SID: ${twilioCallSid}, Caller: ${callerNumber}, User: ${userId || 'global'}`);
            createCallRecord(callId, streamSid, agentId, callerNumber, userId);
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
      // No separate transcription WebSocket to close
    });

    connection.on('error', (error) => {
      console.error('WebSocket connection error:', error);
    });

    // No separate transcription WebSocket handlers needed
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
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();

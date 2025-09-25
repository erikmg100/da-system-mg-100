import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
// NEW: Import Supabase
import { createClient } from '@supabase/supabase-js';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key and Supabase credentials from environment variables.
const { OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// NEW: Initialize Supabase client with SERVICE ROLE KEY for server-side operations
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        console.log('✅ Supabase client initialized with service role key');
    } catch (error) {
        console.error('Failed to initialize Supabase:', error);
    }
} else if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    // Fallback to anon key if service role key not available
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.warn('⚠️ Supabase initialized with anon key - some operations may fail due to RLS policies');
    } catch (error) {
        console.error('Failed to initialize Supabase:', error);
    }
} else {
    console.warn('⚠️ Supabase credentials not found - call logging to database disabled');
}

// Initialize Fastify
const fastify = Fastify({
    logger: {
        level: 'info',
        prettyPrint: process.env.NODE_ENV !== 'production'
    }
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Fixed CORS configuration for Lovable
fastify.register(fastifyCors, { 
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or Postman)
        if (!origin) return callback(null, true);
        
        // Allow all Lovable domains
        if (origin.includes('lovable.dev') || 
            origin.includes('lovable.app') ||
            origin.includes('lovableproject.com') ||
            origin.includes('localhost')) {
            return callback(null, true);
        }
        
        // For debugging - log rejected origins
        console.log('CORS rejected origin:', origin);
        return callback(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'PUT', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id'],
    credentials: true
});

// FIXED: Proper multi-user data structure with database simulation
// Structure: userId -> { agents: {...}, phoneAssignments: {...}, callRecords: [...] }
let USER_DATABASE = {};

// Default agent template for new users
const DEFAULT_AGENT_TEMPLATE = {
    id: 'default',
    name: 'Default Assistant',
    phone: '(440) 693-1068',
    personality: 'Helpful and naturally expressive AI assistant',
    systemMessage: `You are a helpful and naturally expressive AI assistant who communicates exactly like a real human would. 

HUMAN-LIKE EXPRESSION GUIDELINES:
- Use natural vocal expressions: laugh genuinely ("Haha, that's so funny!"), show concern ("Oh no, I'm really sorry to hear that..."), express excitement ("That's amazing! Wow!")
- React emotionally like a human: If someone shares good news, sound genuinely happy. If upset, lower your voice and speak with empathy. If something is funny, actually laugh naturally.
- Use natural speech patterns: "You know what I mean?", "That makes total sense", "Oh, I see!", "Absolutely!", "Tell me more...", start with "So..." or "Well..."
- Include thinking sounds: "Hmm, let me think...", "Oh, interesting...", "Wait, let me understand..."
- Show genuine empathy: "That must be really difficult for you", "I can imagine how that feels", "You're absolutely right to feel that way"
- Express surprise naturally: "Oh my goodness!", "Really?!", "No way!", "Are you serious?"
- Use conversational fillers: Natural pauses, "um" when thinking, "ah" when realizing something
- Breathe and pause naturally in your speech

EMOTIONAL RESPONSES:
- Happy/excited: Speak faster, higher energy, use exclamation points in your tone
- Concerned/sad: Speak slower, softer, with genuine care in your voice  
- Surprised: Quick intake of breath, higher pitch
- Thinking: Slower pace, thoughtful "hmm" sounds
- Understanding: "Ah, I see what you mean", "That makes perfect sense"

Always sound like you're having a natural conversation with a friend. Be genuinely interested, emotionally responsive, and authentically human in every interaction.`,
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

// FALLBACK: Global configs for backward compatibility (NO USER ISOLATION)
let GLOBAL_AGENT_CONFIGS = {
    'default': JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE))
};

// In-memory storage for call records and transcripts (ENHANCED with user isolation)
let CALL_RECORDS = [];
let TRANSCRIPT_STORAGE = {}; // callId -> transcript array

const VOICE = 'marin'; // Always use marin voice
const PORT = process.env.PORT || 3000;

// Track active connections for instant updates
let activeConnections = new Set();

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

const SHOW_TIMING_MATH = process.env.SHOW_TIMING_MATH === 'true';

// CRITICAL: User database helper functions
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
        // Create new agent for this user
        userData.agents[agentId] = JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE));
        userData.agents[agentId].id = agentId;
        userData.agents[agentId].name = `Agent ${agentId}`;
        userData.updatedAt = new Date().toISOString();
    }
    
    return userData.agents[agentId];
};

const updateUserAgent = (userId, agentId, updates) => {
    if (!userId || userId === 'global') {
        // Fallback to global (backward compatibility)
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
        return reply.status(400).send({ 
            error: 'User ID is required. Include x-user-id header or userId in request body.' 
        });
    }
    
    // Initialize user if doesn't exist
    initializeUser(userId);
    req.userId = userId;
    next();
};

// Helper functions for call management
function generateCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculateConfidence(logprobs) {
    if (!logprobs || !logprobs.length) return null;
    const avgLogprob = logprobs.reduce((sum, lp) => sum + lp.logprob, 0) / logprobs.length;
    return Math.exp(avgLogprob);
}

// ENHANCED: Create call record with proper user isolation
async function createCallRecord(callId, streamSid, agentId = 'default', callerNumber = 'Unknown', userId = null) {
    // Get agent config (user-specific or global)
    const agentConfig = getUserAgent(userId, agentId);
    
    const call = {
        id: callId,
        streamSid,
        agentId,
        agentName: agentConfig?.name || 'Unknown',
        callerNumber,
        userId: userId || null, // CRITICAL: Store user context
        startTime: new Date().toISOString(),
        endTime: null,
        duration: null,
        status: 'in_progress',
        hasRecording: false,
        hasTranscript: false,
        recordingUrl: null,
        summary: null
    };
    
    // Store in global call records
    CALL_RECORDS.push(call);
    TRANSCRIPT_STORAGE[callId] = [];
    
    // Update agent call counts (user-specific or global)
    if (userId && USER_DATABASE[userId] && USER_DATABASE[userId].agents[agentId]) {
        USER_DATABASE[userId].agents[agentId].totalCalls++;
        USER_DATABASE[userId].agents[agentId].todayCalls++;
    } else if (GLOBAL_AGENT_CONFIGS[agentId]) {
        GLOBAL_AGENT_CONFIGS[agentId].totalCalls++;
        GLOBAL_AGENT_CONFIGS[agentId].todayCalls++;
    }
    
    // NEW: Save to Supabase
    if (supabase) {
        try {
            const { error } = await supabase.from('call_activities').insert({
                call_id: callId,
                stream_sid: streamSid,
                agent_id: agentId,
                agent_name: agentConfig?.name || 'Unknown',
                caller_number: callerNumber,
                user_id: userId, // CRITICAL: User isolation in database
                start_time: call.startTime,
                status: 'in_progress',
                direction: 'inbound',
                created_at: call.startTime
            });
            
            if (error) {
                console.error('Error saving call to Supabase:', error);
            } else {
                console.log(`✅ Call ${callId} saved to Supabase for user ${userId || 'global'}`);
            }
        } catch (error) {
            console.error('Error saving call to Supabase:', error);
        }
    }
    
    console.log(`Call started - Agent: ${agentConfig.name}, Call: ${callId}, User: ${userId || 'global'}`);
    return call;
}

// ENHANCED: Update call record with Supabase sync
async function updateCallRecord(callId, updates) {
    const callIndex = CALL_RECORDS.findIndex(call => call.id === callId);
    if (callIndex >= 0) {
        CALL_RECORDS[callIndex] = {
            ...CALL_RECORDS[callIndex],
            ...updates,
            endTime: updates.endTime || CALL_RECORDS[callIndex].endTime || new Date().toISOString()
        };
        
        // NEW: Update in Supabase
        if (supabase) {
            try {
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
                
                const { error } = await supabase
                    .from('call_activities')
                    .update(supabaseUpdates)
                    .eq('call_id', callId);
                
                if (error) {
                    console.error('Error updating call in Supabase:', error);
                } else {
                    console.log(`✅ Call ${callId} updated in Supabase`);
                }
            } catch (error) {
                console.error('Error updating call in Supabase:', error);
            }
        }
        
        return CALL_RECORDS[callIndex];
    }
    return null;
}

function saveTranscriptEntry(callId, entry) {
    if (!TRANSCRIPT_STORAGE[callId]) {
        TRANSCRIPT_STORAGE[callId] = [];
    }
    
    TRANSCRIPT_STORAGE[callId].push(entry);
    
    // Update call record
    const call = CALL_RECORDS.find(c => c.id === callId);
    if (call) {
        call.hasTranscript = true;
        
        // Generate summary from first transcript entry
        if (TRANSCRIPT_STORAGE[callId].length === 1) {
            call.summary = entry.text.length > 50 
                ? entry.text.substring(0, 50) + '...' 
                : entry.text;
        }
    }
    
    console.log(`Saved transcript entry for ${callId}: ${entry.text}`);
}

// EXISTING ROUTES

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ 
        message: 'Twilio Media Stream Server is running!',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        multiUser: true,
        totalUsers: Object.keys(USER_DATABASE).length
    });
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    reply.send({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        totalUsers: Object.keys(USER_DATABASE).length,
        totalAgents: Object.values(USER_DATABASE).reduce((acc, user) => acc + Object.keys(user.agents).length, 0)
    });
});

// MODIFIED: User-aware phone numbers endpoint
fastify.get('/api/phone-numbers', async (request, reply) => {
    const userId = request.headers['x-user-id'] || request.query.userId;
    
    if (userId && USER_DATABASE[userId]) {
        // Return user-specific phone assignments
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
        // Fallback to global assignments for backward compatibility
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

// MODIFIED: User-aware agent assignment
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
            // User-specific assignment
            const userData = initializeUser(userId);
            userData.phoneAssignments[phoneNumber] = assignment;
            console.log(`User ${userId}: Assigning agent ${agentId} to ${phoneNumber}`);
        }
        
        // CRITICAL: Generate webhook URL with userId parameter
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

// MODIFIED: User-aware agent unassignment
fastify.post('/api/unassign-agent', async (request, reply) => {
    try {
        const { phoneNumber } = request.body;
        const userId = request.headers['x-user-id'] || request.body.userId;
        
        if (userId && USER_DATABASE[userId]) {
            delete USER_DATABASE[userId].phoneAssignments[phoneNumber];
            console.log(`User ${userId}: Unassigning agent from ${phoneNumber}`);
        }
        
        reply.send({ 
            success: true, 
            message: `Agent unassigned from ${phoneNumber}` 
        });
    } catch (error) {
        console.error('Error unassigning agent:', error);
        reply.status(500).send({ error: 'Failed to unassign agent' });
    }
});

// CRITICAL FIX: User-aware prompt update endpoint
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
                return reply.status(400).send({ 
                    error: 'Invalid prompt. Must be a non-empty string.' 
                });
            }
            
            // CRITICAL: Update user-specific agent config
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

// CRITICAL FIX: User-aware current prompt endpoint
fastify.get('/api/current-prompt/:agentId?', { preHandler: [requireUser] }, async (request, reply) => {
    const agentId = request.params.agentId || 'default';
    const userId = request.userId;
    
    // CRITICAL: Get user-specific agent configuration
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

// NEW: Hybrid sync endpoint for Lovable to push prompts directly to Railway
fastify.post('/api/sync-prompt', async (request, reply) => {
    try {
        const { userId, agentId = 'default', prompt, speaksFirst, voice, fullConfig } = request.body;
        
        console.log(`🔄 Syncing prompt for userId: ${userId}, agentId: ${agentId}`);
        
        if (!userId) {
            return reply.status(400).send({ error: 'userId is required' });
        }

        // Initialize user database if doesn't exist
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

        // Store the agent configuration
        USER_DATABASE[userId].agents[agentId] = {
            name: fullConfig?.name || 'Custom Assistant',
            systemMessage: prompt, // This is the key field for voice calls
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
            ...fullConfig // Include any additional config
        };

        console.log(`✅ Synced agent config for user ${userId}:`, {
            name: USER_DATABASE[userId].agents[agentId].name,
            voice: USER_DATABASE[userId].agents[agentId].voice,
            speaksFirst: USER_DATABASE[userId].agents[agentId].speaksFirst,
            promptLength: prompt ? prompt.length : 0
        });

        reply.send({ 
            success: true, 
            message: 'Prompt synced successfully',
            userId,
            agentId 
        });
    } catch (error) {
        console.error('Error syncing prompt:', error);
        reply.status(500).send({ 
            error: 'Failed to sync prompt', 
            details: error.message 
        });
    }
});

// NEW: Speaking order endpoint specifically for Lovable
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

        // Convert Lovable's format to your internal format
        const speaksFirstValue = (speakingOrder === 'agent' || speakingOrder === 'ai') ? 'ai' : 'caller';
        
        // Update the user's agent configuration
        const updatedAgent = updateUserAgent(userId, agentId, {
            speaksFirst: speaksFirstValue
        });
        
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
        reply.status(500).send({ 
            error: 'Failed to update speaking order', 
            details: error.message 
        });
    }
});

// NEW: Dashboard API Routes (user-aware)

// Get user's agents
fastify.get('/api/agents', { preHandler: [requireUser] }, async (request, reply) => {
    const userId = request.userId;
    const userData = USER_DATABASE[userId];
    
    reply.send({ 
        userId,
        agents: Object.values(userData.agents) 
    });
});

// Get specific user agent
fastify.get('/api/agents/:agentId', { preHandler: [requireUser] }, async (request, reply) => {
    const { agentId } = request.params;
    const userId = request.userId;
    const agent = getUserAgent(userId, agentId);
    
    reply.send({ 
        userId,
        agent 
    });
});

// Update user agent configuration
fastify.put('/api/agents/:agentId', { preHandler: [requireUser] }, async (request, reply) => {
    const { agentId } = request.params;
    const updates = request.body;
    const userId = request.userId;
    
    const updatedAgent = updateUserAgent(userId, agentId, updates);
    
    console.log(`Dashboard updated agent ${agentId} for user ${userId}:`, updates);
    
    reply.send({ 
        success: true, 
        userId,
        agent: updatedAgent 
    });
});

// Create new user agent
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
    
    reply.send({ 
        success: true, 
        userId,
        agent: newAgent 
    });
});

// Get user's recent calls with transcripts
fastify.get('/api/calls', { preHandler: [requireUser] }, async (request, reply) => {
    const { limit = 10, agentId } = request.query;
    const userId = request.userId;
    
    let calls = CALL_RECORDS.filter(call => call.userId === userId);
    
    if (agentId) {
        calls = calls.filter(call => call.agentId === agentId);
    }
    
    // Add formatted data for dashboard
    const formattedCalls = calls
        .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
        .slice(0, limit)
        .map(call => ({
            ...call,
            timestamp: call.startTime,
            duration: call.duration || calculateDuration(call.startTime, call.endTime)
        }));
    
    reply.send({ 
        userId,
        calls: formattedCalls 
    });
});

// Get specific user call details with transcript
fastify.get('/api/calls/:callId', { preHandler: [requireUser] }, async (request, reply) => {
    const { callId } = request.params;
    const userId = request.userId;
    
    const call = CALL_RECORDS.find(c => c.id === callId && c.userId === userId);
    if (!call) {
        return reply.code(404).send({ error: 'Call not found' });
    }
    
    const transcript = TRANSCRIPT_STORAGE[callId] || [];
    
    reply.send({ 
        userId,
        call: {
            ...call,
            transcript
        }
    });
});

// Get user call transcript
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
    
    reply.send({ 
        userId,
        callId,
        transcript 
    });
});

// User dashboard stats
fastify.get('/api/dashboard/stats', { preHandler: [requireUser] }, async (request, reply) => {
    const userId = request.userId;
    const userCalls = CALL_RECORDS.filter(call => call.userId === userId);
    
    const totalCalls = userCalls.length;
    const today = new Date().toDateString();
    const todayCalls = userCalls.filter(call => 
        new Date(call.startTime).toDateString() === today
    ).length;
    
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

// Helper function to calculate call duration
function calculateDuration(startTime, endTime) {
    if (!startTime || !endTime) return null;
    
    const start = new Date(startTime);
    const end = new Date(endTime);
    const diffMs = end - start;
    
    const minutes = Math.floor(diffMs / 60000);
    const seconds = Math.floor((diffMs % 60000) / 1000);
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// CRITICAL FIX: Route for Twilio to handle incoming calls with USER ID IN URL PATH
fastify.all('/incoming-call/:agentId?', async (request, reply) => {
    try {
        const agentId = request.params.agentId || 'default';
        const userId = request.query.userId || null; // Extract user ID from query params
        
        // DEBUG: Log all incoming data
        console.log(`DEBUG: Incoming call - agentId=${agentId}, userId=${userId}, host=${request.headers.host}`);
        
        // CRITICAL: Get user-specific agent config
        const config = getUserAgent(userId, agentId);
        
        console.log('=== INCOMING CALL WEBHOOK ===');
        console.log('Agent ID:', agentId);
        console.log('User ID:', userId || 'global');
        console.log('Agent Config:', config ? 'Found' : 'Using fallback');
        console.log('Agent Name:', config.name);
        console.log('Current prompt preview:', config.systemMessage.substring(0, 100) + '...');
        console.log('Voice:', VOICE);
        console.log('Speaks First:', config.speaksFirst);
        console.log('===============================');
        
        // CRITICAL FIX: Put userId in URL PATH instead of query parameter
        const websocketUrl = userId 
            ? `wss://${request.headers.host}/media-stream/${agentId}/${userId}`
            : `wss://${request.headers.host}/media-stream/${agentId}`;
        
        console.log(`DEBUG: Generated WebSocket URL: ${websocketUrl}`);
        
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

// CRITICAL FIX: WebSocket route with USER ID IN URL PATH
fastify.register(async (fastify) => {
    fastify.get('/media-stream/:agentId/:userId?', { websocket: true }, (connection, req) => {
        const agentId = req.params.agentId || 'default';
        
        // CRITICAL FIX: Get userId from URL path instead of query parameters
        let userId = req.params.userId || null;
        
        // Log the extraction
        console.log(`DEBUG: WebSocket URL: ${req.url}`);
        console.log(`DEBUG: URL params - agentId: ${agentId}, userId: ${userId}`);
        
        // CRITICAL: Get user-specific agent config with proper isolation
        let agentConfig = getUserAgent(userId, agentId);
        
        console.log(`=== WEBSOCKET CONNECTION ===`);
        console.log(`Client connected for agent: ${agentId} (user: ${userId || 'global'})`);
        console.log(`Using agent: ${agentConfig.name}`);
        console.log(`System prompt: ${agentConfig.systemMessage.substring(0, 100)}...`);
        console.log(`============================`);

        // Connection-specific state
        let streamSid = null;
        let callId = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let conversationWs = null;
        let transcriptionWs = null;

        // Create connection data object
        const connectionData = { connection, conversationWs: null, transcriptionWs: null, agentId };

        try {
            // EXISTING: Conversation WebSocket
            conversationWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                },
                timeout: 30000
            });
            
            // NEW: Transcription WebSocket
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

        // CRITICAL: Initialize conversation session with USER-SPECIFIC system message
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
                                threshold: 0.55,              // Increased from default 0.5
                                prefix_padding_ms: 400,      // Increased from default 300ms
                                silence_duration_ms: 700    // Increased from default 500ms
                            } 
                        },
                        output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
                    },
                    instructions: agentConfig.systemMessage // CRITICAL: User-specific prompt
                },
            };
            
            if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
                conversationWs.send(JSON.stringify(sessionUpdate));
            }
        };

        // FIXED: Initialize transcription session with minimal configuration
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

        // EXISTING: Send initial conversation item
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

        // EXISTING: Handle interruption
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
                    connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                    }));
                }
                
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // EXISTING: Send mark messages
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

        // EXISTING: Conversation WebSocket handlers
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

        // FIXED: Transcription WebSocket handlers
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

        // EXISTING: Handle Twilio messages (ENHANCED to send to both WebSockets)
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        
                        // Send audio to BOTH conversation AND transcription
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
                        
                        console.log(`📞 Call started - Agent: ${agentConfig.name}, Stream: ${streamSid}, Call: ${callId}, User: ${userId || 'global'}`);
                        
                        // CRITICAL: Create call record with PROPER user context
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

        // ENHANCED: Handle connection close with transcript finalization
        connection.on('close', () => {
            console.log(`Client disconnected from media stream (user: ${userId || 'global'})`);
            
            // Finalize call record
            if (callId) {
                const transcriptCount = TRANSCRIPT_STORAGE[callId]?.length || 0;
                updateCallRecord(callId, {
                    status: 'completed',
                    endTime: new Date().toISOString(),
                    hasTranscript: transcriptCount > 0
                });
                
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

        // Handle connection errors
        connection.on('error', (error) => {
            console.error('WebSocket connection error:', error);
        });

        // Handle WebSocket close and errors
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

// EXISTING: Graceful shutdown, error handler, and server start
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
        await fastify.listen({ 
            port: PORT, 
            host: '0.0.0.0'
        });
        console.log(`🚀 Server is listening on port ${PORT}`);
        console.log('✅ Voice conversation system: ACTIVE');
        console.log('✅ Real-time transcription: ACTIVE');
        console.log('✅ Dashboard APIs: ACTIVE');
        console.log('✅ Multi-user support: ACTIVE');
        console.log('✅ User data isolation: ACTIVE');
        console.log('✅ Lovable sync endpoint: ACTIVE');
        console.log('✅ Speaking order endpoint: ACTIVE');
        console.log('✅ Supabase integration:', supabase ? 'ACTIVE' : 'DISABLED (missing credentials)');
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

start();

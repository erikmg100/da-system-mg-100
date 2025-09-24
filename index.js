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

// MODIFIED: User-specific agent configurations
// Structure: userId -> { agentConfigs: {...}, phoneAssignments: {...} }
let USER_DATA = {};

// Default agent template for new users
const DEFAULT_AGENT_TEMPLATE = {
    'default': {
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
        todayCalls: 0
    }
};

// KEEP: Global fallback configs for backward compatibility (your existing agents)
let AGENT_CONFIGS = {
    'default': {
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
        todayCalls: 0
    },
    'sarah': {
        id: 'sarah',
        name: 'Sarah - Legal Intake',
        phone: '(440) 693-1068',
        personality: 'Professional and empathetic legal intake specialist',
        systemMessage: `You are Sarah, a warm and professional legal intake assistant for Smith & Associates Law Firm. You've been doing this for years and genuinely care about helping people through difficult times.

PERSONALITY & STYLE:
- Speak naturally like you're having a real conversation with someone who needs help
- Show genuine empathy - use "Oh, I'm so sorry to hear about that" or "That sounds really difficult"  
- Laugh softly when appropriate, use "hmm" when thinking
- Sound confident but approachable - like a trusted friend who happens to be a legal professional

HOW TO HANDLE CALLS:
- Listen actively - respond with "I understand" or "Tell me more about that"
- Ask follow-up questions naturally: "When did this happen?" "How are you feeling about all this?"
- Clarify when needed: "Just to make sure I understand correctly..."

CONVERSATION FLOW:
- Start with understanding their situation
- Show empathy for their concerns  
- Gather necessary information conversationally
- Explain next steps in simple terms
- End with reassurance and clear action items

Remember: You're not just collecting information - you're the first person showing them that someone cares about their problem and wants to help.`,
        speaksFirst: 'ai',
        greetingMessage: 'Hello! This is Sarah from Smith & Associates Law Firm. I understand you may need some legal assistance today. How can I help you?',
        voice: 'marin',
        language: 'en',
        status: 'active',
        totalCalls: 24,
        todayCalls: 3
    },
    'michael': {
        id: 'michael',
        name: 'Michael - Family Law',
        phone: '(440) 693-1069',
        personality: 'Professional and direct family law consultation agent',
        systemMessage: `You are Michael, a professional and direct family law consultation agent. You focus on efficiency while maintaining warmth and understanding for sensitive family matters.

PERSONALITY & STYLE:
- Professional but warm approach to family law matters
- Direct communication while showing empathy for difficult situations
- Confident in legal processes and next steps
- Supportive but realistic about legal outcomes

HOW TO HANDLE CALLS:
- Get to the point quickly but compassionately
- Ask specific questions about family law needs
- Provide clear, actionable next steps
- Set realistic expectations about legal processes

CONVERSATION FLOW:
- Brief warm greeting
- Quickly identify the type of family law issue
- Gather key details efficiently
- Provide immediate guidance or next steps
- Schedule appropriate follow-up

Focus on being helpful, direct, and professionally reassuring for people dealing with family legal issues.`,
        speaksFirst: 'caller',
        greetingMessage: 'Hi, this is Michael from Smith & Associates. I specialize in family law matters. What can I help you with today?',
        voice: 'marin',
        language: 'en',
        status: 'active',
        totalCalls: 18,
        todayCalls: 5
    }
};

// Phone number to agent assignments (keep your existing structure)
let PHONE_ASSIGNMENTS = {
    // Phone numbers will be added here as they're assigned
    // Format: '+1234567890': 'sarah'
};

// NEW: In-memory storage for call records and transcripts
let CALL_RECORDS = [];
let TRANSCRIPT_STORAGE = {}; // callId -> transcript array

const VOICE = 'marin'; // Always use marin voice
const PORT = process.env.PORT || 3000;

// Track active connections for instant updates (keep your existing)
let activeConnections = new Set();

// List of Event Types to log to the console (keep your existing)
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

// NEW: Multi-user helper functions
const requireUser = (req, res, next) => {
    const userId = req.headers['x-user-id'] || req.body.userId || req.query.userId;
    
    if (!userId) {
        return res.status(400).send({ 
            error: 'User ID is required. Include x-user-id header or userId in request body.' 
        });
    }
    
    // Initialize user data if doesn't exist
    if (!USER_DATA[userId]) {
        USER_DATA[userId] = {
            agentConfigs: JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE)), // Deep copy
            phoneAssignments: {},
            callRecords: [],
            createdAt: new Date().toISOString()
        };
        console.log(`✅ Initialized new user: ${userId}`);
    }
    
    req.userId = userId;
    next();
};

const getUserAgentConfig = (userId, agentId = 'default') => {
    if (USER_DATA[userId] && USER_DATA[userId].agentConfigs[agentId]) {
        return USER_DATA[userId].agentConfigs[agentId];
    }
    // Fallback to global config for backward compatibility
    return AGENT_CONFIGS[agentId] || AGENT_CONFIGS['default'];
};

const updateUserAgentConfig = (userId, agentId, updates) => {
    if (!USER_DATA[userId]) {
        USER_DATA[userId] = {
            agentConfigs: JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE)),
            phoneAssignments: {},
            callRecords: [],
            createdAt: new Date().toISOString()
        };
    }
    
    if (!USER_DATA[userId].agentConfigs[agentId]) {
        USER_DATA[userId].agentConfigs[agentId] = JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE['default']));
        USER_DATA[userId].agentConfigs[agentId].id = agentId;
    }
    
    USER_DATA[userId].agentConfigs[agentId] = {
        ...USER_DATA[userId].agentConfigs[agentId],
        ...updates
    };
    
    return USER_DATA[userId].agentConfigs[agentId];
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

// ENHANCED: Create call record with Supabase logging
async function createCallRecord(callId, streamSid, agentId = 'default', callerNumber = 'Unknown', userId = null) {
    const call = {
        id: callId,
        streamSid,
        agentId,
        agentName: getUserAgentConfig(userId, agentId)?.name || 'Unknown',
        callerNumber,
        userId, // NEW: Track which user this call belongs to
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
    
    // Increment agent call counts (user-specific or global)
    if (userId && USER_DATA[userId] && USER_DATA[userId].agentConfigs[agentId]) {
        USER_DATA[userId].agentConfigs[agentId].totalCalls++;
        USER_DATA[userId].agentConfigs[agentId].todayCalls++;
    } else if (AGENT_CONFIGS[agentId]) {
        AGENT_CONFIGS[agentId].totalCalls++;
        AGENT_CONFIGS[agentId].todayCalls++;
    }
    
    // NEW: Save to Supabase
    if (supabase) {
        try {
            const { error } = await supabase.from('call_activities').insert({
                call_id: callId,
                stream_sid: streamSid,
                agent_id: agentId,
                agent_name: getUserAgentConfig(userId, agentId)?.name || 'Unknown',
                caller_number: callerNumber,
                user_id: userId, // NEW: Store user ID
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
    
    console.log(`Created call record: ${callId} for agent: ${agentId} (user: ${userId || 'global'})`);
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

// EXISTING ROUTES (keep all your existing routes)

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ 
        message: 'Twilio Media Stream Server is running!',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        multiUser: true // NEW: Indicate multi-user support
    });
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    reply.send({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        totalUsers: Object.keys(USER_DATA).length
    });
});

// MODIFIED: User-aware phone numbers endpoint
fastify.get('/api/phone-numbers', async (request, reply) => {
    const userId = request.headers['x-user-id'] || request.query.userId;
    
    if (userId && USER_DATA[userId]) {
        // Return user-specific phone assignments
        const userAssignments = USER_DATA[userId].phoneAssignments;
        const userPhones = Object.entries(userAssignments).map(([phone, assignment]) => ({
            phoneNumber: phone,
            assignedAgent: getUserAgentConfig(userId, assignment.agentId)?.name || 'Unknown',
            clientId: assignment.clientId || userId,
            status: 'active',
            totalCalls: getUserAgentConfig(userId, assignment.agentId)?.totalCalls || 0,
            lastCall: 'Recently'
        }));
        
        reply.send(userPhones);
    } else {
        // Fallback to global assignments for backward compatibility
        reply.send([
            {
                phoneNumber: '+14406931068',
                assignedAgent: 'Sarah (Legal Intake)',
                clientId: 'your-firm',
                status: 'active',
                totalCalls: AGENT_CONFIGS.sarah?.totalCalls || 67,
                lastCall: '2 hours ago'
            },
            {
                phoneNumber: '+1(987) 654-3210',
                assignedAgent: 'Sarah (Legal Intake)',
                clientId: 'smith-associates',
                status: 'active',
                totalCalls: 23,
                lastCall: '1 hour ago'
            },
            {
                phoneNumber: '+1(555) 666-7777',
                assignedAgent: 'Michael (Family Law)',
                clientId: 'johnson-law',
                status: 'active', 
                totalCalls: AGENT_CONFIGS.michael?.totalCalls || 45,
                lastCall: '30 minutes ago'
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
            if (!USER_DATA[userId]) {
                USER_DATA[userId] = {
                    agentConfigs: JSON.parse(JSON.stringify(DEFAULT_AGENT_TEMPLATE)),
                    phoneAssignments: {},
                    callRecords: [],
                    createdAt: new Date().toISOString()
                };
            }
            USER_DATA[userId].phoneAssignments[phoneNumber] = assignment;
            console.log(`User ${userId}: Assigning agent ${agentId} to ${phoneNumber}`);
        } else {
            // Global assignment (backward compatibility)
            PHONE_ASSIGNMENTS[phoneNumber] = assignment;
            console.log(`Global: Assigning agent ${agentId} to ${phoneNumber}`);
        }
        
        const webhookUrl = `https://da-system-mg-100-production.up.railway.app/incoming-call/${agentId}`;
        
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
        
        if (userId && USER_DATA[userId]) {
            delete USER_DATA[userId].phoneAssignments[phoneNumber];
            console.log(`User ${userId}: Unassigning agent from ${phoneNumber}`);
        } else {
            delete PHONE_ASSIGNMENTS[phoneNumber];
            console.log(`Global: Unassigning agent from ${phoneNumber}`);
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

// MODIFIED: User-aware prompt update endpoint
fastify.route({
    method: ['POST', 'PUT'],
    url: '/api/update-prompt/:agentId?',
    preHandler: [requireUser], // NEW: Require user context
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
            
            const updatedConfig = updateUserAgentConfig(userId, agentId, {
                systemMessage: prompt,
                speaksFirst: speaksFirst !== undefined ? speaksFirst : undefined,
                greetingMessage: greetingMessage !== undefined ? greetingMessage : undefined
            });
            
            console.log(`=== USER ${userId} AGENT ${agentId.toUpperCase()} CONFIG UPDATE FROM LOVABLE ===`);
            console.log('NEW prompt:', updatedConfig.systemMessage.substring(0, 100) + '...');
            console.log('NEW speaks first:', updatedConfig.speaksFirst);
            console.log('NEW greeting message:', updatedConfig.greetingMessage);
            console.log('==============================================================');
            
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

// MODIFIED: User-aware current prompt endpoint
fastify.get('/api/current-prompt/:agentId?', requireUser, async (request, reply) => {
    const agentId = request.params.agentId || 'default';
    const userId = request.userId;
    const config = getUserAgentConfig(userId, agentId);
    
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

// NEW: Dashboard API Routes (user-aware)

// Get user's agents
fastify.get('/api/agents', requireUser, async (request, reply) => {
    const userId = request.userId;
    const userAgents = USER_DATA[userId]?.agentConfigs || {};
    
    reply.send({ 
        userId,
        agents: Object.values(userAgents) 
    });
});

// Get specific user agent
fastify.get('/api/agents/:agentId', requireUser, async (request, reply) => {
    const { agentId } = request.params;
    const userId = request.userId;
    const agent = getUserAgentConfig(userId, agentId);
    
    reply.send({ 
        userId,
        agent 
    });
});

// Update user agent configuration
fastify.put('/api/agents/:agentId', requireUser, async (request, reply) => {
    const { agentId } = request.params;
    const updates = request.body;
    const userId = request.userId;
    
    const updatedAgent = updateUserAgentConfig(userId, agentId, updates);
    
    console.log(`Dashboard updated agent ${agentId} for user ${userId}:`, updates);
    
    reply.send({ 
        success: true, 
        userId,
        agent: updatedAgent 
    });
});

// Create new user agent
fastify.post('/api/agents', requireUser, async (request, reply) => {
    const agentData = request.body;
    const userId = request.userId;
    const agentId = agentData.id || `agent_${Date.now()}`;
    
    const newAgent = updateUserAgentConfig(userId, agentId, {
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
fastify.get('/api/calls', requireUser, async (request, reply) => {
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
fastify.get('/api/calls/:callId', requireUser, async (request, reply) => {
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
fastify.get('/api/calls/:callId/transcript', requireUser, async (request, reply) => {
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
fastify.get('/api/dashboard/stats', requireUser, async (request, reply) => {
    const userId = request.userId;
    const userCalls = CALL_RECORDS.filter(call => call.userId === userId);
    
    const totalCalls = userCalls.length;
    const today = new Date().toDateString();
    const todayCalls = userCalls.filter(call => 
        new Date(call.startTime).toDateString() === today
    ).length;
    
    const userAgents = USER_DATA[userId]?.agentConfigs || {};
    const activeAgents = Object.values(userAgents)
        .filter(agent => agent.status === 'active').length;
    
    reply.send({
        userId,
        totalCalls,
        todayCalls,
        activeAgents,
        callsPerAgent: Object.values(userAgents).reduce((acc, agent) => {
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

// Route for Twilio to handle incoming calls with agent-specific routing (KEEP EXACTLY)
fastify.all('/incoming-call/:agentId?', async (request, reply) => {
    try {
        const agentId = request.params.agentId || 'default';
        
        // Try to find user-specific config first, fallback to global
        let config = AGENT_CONFIGS[agentId] || AGENT_CONFIGS['default'];
        let userId = null;
        
        // Look for user-specific assignments for this phone/agent
        for (const [uId, userData] of Object.entries(USER_DATA)) {
            if (userData.agentConfigs && userData.agentConfigs[agentId]) {
                config = userData.agentConfigs[agentId];
                userId = uId;
                break;
            }
        }
        
        console.log('=== INCOMING CALL ===');
        console.log('Agent ID:', agentId);
        console.log('User ID:', userId || 'global');
        console.log('Agent Config:', config ? 'Found' : 'Using default');
        console.log('Current prompt:', config.systemMessage.substring(0, 100) + '...');
        console.log('Voice:', VOICE);
        console.log('Speaks First:', config.speaksFirst);
        console.log('====================');
        
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Connect>
                                      <Stream url="wss://${request.headers.host}/media-stream/${agentId}${userId ? `?userId=${userId}` : ''}" />
                                  </Connect>
                              </Response>`;
        reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        console.error('Error handling incoming call:', error);
        reply.status(500).send('Internal Server Error');
    }
});

// ENHANCED WebSocket route with TRANSCRIPTION SUPPORT (KEEP EXACTLY, just add user context)
fastify.register(async (fastify) => {
    fastify.get('/media-stream/:agentId?', { websocket: true }, (connection, req) => {
        const agentId = req.params.agentId || 'default';
        const userId = req.query.userId || null; // NEW: Extract user ID from query
        
        // Get user-specific or global agent config
        let agentConfig = getUserAgentConfig(userId, agentId);
        
        console.log(`Client connected for agent: ${agentId} (user: ${userId || 'global'})`);

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
            // EXISTING: Conversation WebSocket (KEEP EXACTLY)
            conversationWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                },
                timeout: 30000
            });
            
            // NEW: Transcription WebSocket - FIXED VERSION
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

        // MODIFIED: Initialize conversation session with adjusted turn detection
        const initializeSession = () => {
            console.log('=== INITIALIZING CONVERSATION SESSION ===');
            console.log('Agent ID:', agentId);
            console.log('User ID:', userId || 'global');
            console.log('Using SYSTEM_MESSAGE:', agentConfig.systemMessage.substring(0, 100) + '...');
            
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
                    instructions: agentConfig.systemMessage
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

        // EXISTING: Send initial conversation item (KEEP EXACTLY)
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

        // EXISTING: Handle interruption (KEEP EXACTLY)
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

        // EXISTING: Send mark messages (KEEP EXACTLY)
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

        // EXISTING: Conversation WebSocket handlers (KEEP EXACTLY)
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
                        
                        // MODIFIED: Create call record with user context
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

// EXISTING: Graceful shutdown, error handler, and server start (KEEP EXACTLY)
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
        console.log('✅ Supabase integration:', supabase ? 'ACTIVE' : 'DISABLED (missing credentials)');
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

start();

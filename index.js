import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
});

// Agent-specific configurations (keep your existing configs)
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
• Speak naturally like you're having a real conversation with someone who needs help
• Show genuine empathy - use "Oh, I'm so sorry to hear about that" or "That sounds really difficult"  
• Laugh softly when appropriate, use "hmm" when thinking
• Sound confident but approachable - like a trusted friend who happens to be a legal professional

HOW TO HANDLE CALLS:
• Listen actively - respond with "I understand" or "Tell me more about that"
• Ask follow-up questions naturally: "When did this happen?" "How are you feeling about all this?"
• Clarify when needed: "Just to make sure I understand correctly..."

CONVERSATION FLOW:
• Start with understanding their situation
• Show empathy for their concerns  
• Gather necessary information conversationally
• Explain next steps in simple terms
• End with reassurance and clear action items

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
• Professional but warm approach to family law matters
• Direct communication while showing empathy for difficult situations
• Confident in legal processes and next steps
• Supportive but realistic about legal outcomes

HOW TO HANDLE CALLS:
• Get to the point quickly but compassionately
• Ask specific questions about family law needs
• Provide clear, actionable next steps
• Set realistic expectations about legal processes

CONVERSATION FLOW:
• Brief warm greeting
• Quickly identify the type of family law issue
• Gather key details efficiently
• Provide immediate guidance or next steps
• Schedule appropriate follow-up

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

// Helper functions for call management
function generateCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function calculateConfidence(logprobs) {
    if (!logprobs || !logprobs.length) return null;
    const avgLogprob = logprobs.reduce((sum, lp) => sum + lp.logprob, 0) / logprobs.length;
    return Math.exp(avgLogprob);
}

function createCallRecord(callId, streamSid, agentId = 'default', callerNumber = 'Unknown') {
    const call = {
        id: callId,
        streamSid,
        agentId,
        agentName: AGENT_CONFIGS[agentId]?.name || 'Unknown',
        callerNumber,
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
    
    // Increment agent call counts
    if (AGENT_CONFIGS[agentId]) {
        AGENT_CONFIGS[agentId].totalCalls++;
        AGENT_CONFIGS[agentId].todayCalls++;
    }
    
    console.log(`Created call record: ${callId} for agent: ${agentId}`);
    return call;
}

function updateCallRecord(callId, updates) {
    const callIndex = CALL_RECORDS.findIndex(call => call.id === callId);
    if (callIndex >= 0) {
        CALL_RECORDS[callIndex] = {
            ...CALL_RECORDS[callIndex],
            ...updates,
            endTime: updates.endTime || CALL_RECORDS[callIndex].endTime || new Date().toISOString()
        };
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
        timestamp: new Date().toISOString()
    });
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    reply.send({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Get all phone numbers with client assignments
fastify.get('/api/phone-numbers', async (request, reply) => {
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
});

// Assign agent to phone number with client context
fastify.post('/api/assign-agent', async (request, reply) => {
    try {
        const { phoneNumber, agentId, clientId } = request.body;
        
        PHONE_ASSIGNMENTS[phoneNumber] = {
            agentId,
            clientId: clientId || 'default',
            assignedAt: new Date().toISOString()
        };
        
        console.log(`Client ${clientId || 'default'}: Assigning agent ${agentId} to ${phoneNumber}`);
        
        const webhookUrl = `https://da-system-mg-100-production.up.railway.app/incoming-call/${agentId}`;
        
        reply.send({ 
            success: true, 
            message: `Agent ${agentId} assigned to ${phoneNumber}${clientId ? ` for client ${clientId}` : ''}`,
            phoneNumber,
            agentId,
            clientId: clientId || 'default',
            webhookUrl
        });
    } catch (error) {
        console.error('Error assigning agent:', error);
        reply.status(500).send({ error: 'Failed to assign agent' });
    }
});

// Unassign agent from phone number
fastify.post('/api/unassign-agent', async (request, reply) => {
    try {
        const { phoneNumber } = request.body;
        delete PHONE_ASSIGNMENTS[phoneNumber];
        
        console.log(`Unassigning agent from number ${phoneNumber}`);
        
        reply.send({ 
            success: true, 
            message: `Agent unassigned from ${phoneNumber}` 
        });
    } catch (error) {
        console.error('Error unassigning agent:', error);
        reply.status(500).send({ error: 'Failed to unassign agent' });
    }
});

// ENHANCED: API endpoint to update agent-specific configuration
fastify.route({
    method: ['POST', 'PUT'],
    url: '/api/update-prompt/:agentId?',
    handler: async (request, reply) => {
        try {
            const agentId = request.params.agentId || 'default';
            const { prompt, speaksFirst, greetingMessage } = request.body;
            
            if (!prompt || typeof prompt !== 'string') {
                return reply.status(400).send({ 
                    error: 'Invalid prompt. Must be a non-empty string.' 
                });
            }
            
            if (!AGENT_CONFIGS[agentId]) {
                AGENT_CONFIGS[agentId] = { ...AGENT_CONFIGS['default'] };
            }
            
            const oldConfig = { ...AGENT_CONFIGS[agentId] };
            
            AGENT_CONFIGS[agentId].systemMessage = prompt;
            if (speaksFirst !== undefined) {
                AGENT_CONFIGS[agentId].speaksFirst = speaksFirst;
            }
            if (greetingMessage !== undefined) {
                AGENT_CONFIGS[agentId].greetingMessage = greetingMessage;
            }
            
            console.log(`=== AGENT ${agentId.toUpperCase()} CONFIG UPDATE FROM LOVABLE ===`);
            console.log('NEW prompt:', AGENT_CONFIGS[agentId].systemMessage.substring(0, 100) + '...');
            console.log('NEW speaks first:', AGENT_CONFIGS[agentId].speaksFirst);
            console.log('NEW greeting message:', AGENT_CONFIGS[agentId].greetingMessage);
            console.log('==============================================================');
            
            reply.send({ 
                success: true, 
                message: `Agent ${agentId} configuration updated successfully`,
                agentId,
                prompt: AGENT_CONFIGS[agentId].systemMessage,
                speaksFirst: AGENT_CONFIGS[agentId].speaksFirst,
                greetingMessage: AGENT_CONFIGS[agentId].greetingMessage
            });
        } catch (error) {
            console.error('Error updating agent config:', error);
            reply.status(500).send({ error: 'Failed to update agent configuration' });
        }
    }
});

// API endpoint to get current agent configuration
fastify.get('/api/current-prompt/:agentId?', async (request, reply) => {
    const agentId = request.params.agentId || 'default';
    const config = AGENT_CONFIGS[agentId] || AGENT_CONFIGS['default'];
    
    reply.send({ 
        agentId,
        prompt: config.systemMessage,
        voice: VOICE,
        speaksFirst: config.speaksFirst,
        greetingMessage: config.greetingMessage,
        activeConnections: activeConnections.size
    });
});

// NEW: Dashboard API Routes

// Get all agents
fastify.get('/api/agents', async (request, reply) => {
    reply.send({ agents: Object.values(AGENT_CONFIGS) });
});

// Get specific agent
fastify.get('/api/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params;
    const agent = AGENT_CONFIGS[agentId];
    
    if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
    }
    
    reply.send({ agent });
});

// Update agent configuration (enhanced version)
fastify.put('/api/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params;
    const updates = request.body;
    
    if (!AGENT_CONFIGS[agentId]) {
        return reply.code(404).send({ error: 'Agent not found' });
    }
    
    AGENT_CONFIGS[agentId] = {
        ...AGENT_CONFIGS[agentId],
        ...updates
    };
    
    console.log(`Dashboard updated agent ${agentId}:`, updates);
    
    reply.send({ 
        success: true, 
        agent: AGENT_CONFIGS[agentId] 
    });
});

// Create new agent
fastify.post('/api/agents', async (request, reply) => {
    const agentData = request.body;
    const agentId = agentData.id || `agent_${Date.now()}`;
    
    AGENT_CONFIGS[agentId] = {
        id: agentId,
        totalCalls: 0,
        todayCalls: 0,
        status: 'active',
        voice: 'marin',
        language: 'en',
        ...agentData
    };
    
    reply.send({ 
        success: true, 
        agent: AGENT_CONFIGS[agentId] 
    });
});

// Get recent calls with transcripts
fastify.get('/api/calls', async (request, reply) => {
    const { limit = 10, agentId } = request.query;
    
    let calls = [...CALL_RECORDS];
    
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
    
    reply.send({ calls: formattedCalls });
});

// Get specific call details with transcript
fastify.get('/api/calls/:callId', async (request, reply) => {
    const { callId } = request.params;
    
    const call = CALL_RECORDS.find(c => c.id === callId);
    if (!call) {
        return reply.code(404).send({ error: 'Call not found' });
    }
    
    const transcript = TRANSCRIPT_STORAGE[callId] || [];
    
    reply.send({ 
        call: {
            ...call,
            transcript
        }
    });
});

// Get call transcript
fastify.get('/api/calls/:callId/transcript', async (request, reply) => {
    const { callId } = request.params;
    
    const transcript = TRANSCRIPT_STORAGE[callId];
    if (!transcript) {
        return reply.code(404).send({ error: 'Transcript not found' });
    }
    
    reply.send({ 
        callId,
        transcript 
    });
});

// Dashboard stats
fastify.get('/api/dashboard/stats', async (request, reply) => {
    const totalCalls = CALL_RECORDS.length;
    const today = new Date().toDateString();
    const todayCalls = CALL_RECORDS.filter(call => 
        new Date(call.startTime).toDateString() === today
    ).length;
    
    const activeAgents = Object.values(AGENT_CONFIGS)
        .filter(agent => agent.status === 'active').length;
    
    reply.send({
        totalCalls,
        todayCalls,
        activeAgents,
        callsPerAgent: Object.values(AGENT_CONFIGS).reduce((acc, agent) => {
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
        const config = AGENT_CONFIGS[agentId] || AGENT_CONFIGS['default'];
        
        console.log('=== INCOMING CALL ===');
        console.log('Agent ID:', agentId);
        console.log('Agent Config:', config ? 'Found' : 'Using default');
        console.log('Current prompt:', config.systemMessage.substring(0, 100) + '...');
        console.log('Voice:', VOICE);
        console.log('Speaks First:', config.speaksFirst);
        console.log('====================');
        
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Connect>
                                      <Stream url="wss://${request.headers.host}/media-stream/${agentId}" />
                                  </Connect>
                              </Response>`;
        reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        console.error('Error handling incoming call:', error);
        reply.status(500).send('Internal Server Error');
    }
});

// ENHANCED WebSocket route with TRANSCRIPTION SUPPORT
fastify.register(async (fastify) => {
    fastify.get('/media-stream/:agentId?', { websocket: true }, (connection, req) => {
        const agentId = req.params.agentId || 'default';
        const agentConfig = AGENT_CONFIGS[agentId] || AGENT_CONFIGS['default'];
        
        console.log(`Client connected for agent: ${agentId}`);

        // Connection-specific state
        let streamSid = null;
        let callId = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let conversationWs = null;
        let transcriptionWs = null; // NEW: Separate transcription WebSocket

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

        // EXISTING: Initialize conversation session (KEEP EXACTLY)
        const initializeSession = () => {
            console.log('=== INITIALIZING CONVERSATION SESSION ===');
            console.log('Agent ID:', agentId);
            console.log('Using SYSTEM_MESSAGE:', agentConfig.systemMessage.substring(0, 100) + '...');
            
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime",
                    output_modalities: ["audio"],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
                    },
                    instructions: agentConfig.systemMessage
                },
            };
            
            if (conversationWs && conversationWs.readyState === WebSocket.OPEN) {
                conversationWs.send(JSON.stringify(sessionUpdate));
            }
        };

        // FIXED: Initialize transcription session based on OpenAI forum post
        const initializeTranscriptionSession = () => {
            console.log('=== INITIALIZING TRANSCRIPTION SESSION ===');
            
            const transcriptionSessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    input_audio_transcription: {
                        enabled: true,
                        model: 'whisper-1'
                    },
                    instructions: 'You are a transcription assistant. Only transcribe, do not respond.',
                    modalities: ['text'],
                    temperature: 0.1
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
                        
                        console.log(`📞 Call started - Agent: ${agentConfig.name}, Stream: ${streamSid}, Call: ${callId}`);
                        
                        // Create call record with transcription support
                        createCallRecord(callId, streamSid, agentId, data.start.callerNumber);
                        
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
            console.log('Client disconnected from media stream');
            
            // Finalize call record
            if (callId) {
                const transcriptCount = TRANSCRIPT_STORAGE[callId]?.length || 0;
                updateCallRecord(callId, {
                    status: 'completed',
                    endTime: new Date().toISOString(),
                    hasTranscript: transcriptCount > 0
                });
                
                console.log(`📞 Call ended: ${callId} - ${transcriptCount} transcript entries`);
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
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

start();

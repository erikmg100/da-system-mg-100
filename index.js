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

// Agent-specific configurations instead of global settings
let AGENT_CONFIGS = {
    'default': {
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
        temperature: 0.8,
        speaksFirst: 'caller',
        greetingMessage: 'Hello there! How can I help you today?'
    },
    'sarah': {
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
        temperature: 0.7,
        speaksFirst: 'ai',
        greetingMessage: 'Hello! This is Sarah from Smith & Associates Law Firm. I understand you may need some legal assistance today. How can I help you?'
    },
    'michael': {
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
        temperature: 0.6,
        speaksFirst: 'caller',
        greetingMessage: 'Hi, this is Michael from Smith & Associates. I specialize in family law matters. What can I help you with today?'
    }
};

// Phone number to agent assignments
let PHONE_ASSIGNMENTS = {
    // Phone numbers will be added here as they're assigned
    // Format: '+1234567890': 'sarah'
};

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
    // For now, manually list your 3 numbers (yours + 2 law firms)
    reply.send([
        {
            phoneNumber: '+14406931068', // Your actual Twilio number
            assignedAgent: 'Sarah (Legal Intake)',
            clientId: 'your-firm',
            status: 'active',
            totalCalls: 67,
            lastCall: '2 hours ago'
        },
        {
            phoneNumber: '+1(987) 654-3210', // Law Firm 1's number  
            assignedAgent: 'Sarah (Legal Intake)',
            clientId: 'smith-associates',
            status: 'active',
            totalCalls: 23,
            lastCall: '1 hour ago'
        },
        {
            phoneNumber: '+1(555) 666-7777', // Law Firm 2's number
            assignedAgent: 'Michael (Family Law)',
            clientId: 'johnson-law',
            status: 'active', 
            totalCalls: 45,
            lastCall: '30 minutes ago'
        }
    ]);
});

// Assign agent to phone number with client context
fastify.post('/api/assign-agent', async (request, reply) => {
    try {
        const { phoneNumber, agentId, clientId } = request.body;
        
        // Store assignment with client context
        PHONE_ASSIGNMENTS[phoneNumber] = {
            agentId,
            clientId: clientId || 'default',
            assignedAt: new Date().toISOString()
        };
        
        console.log(`Client ${clientId || 'default'}: Assigning agent ${agentId} to ${phoneNumber}`);
        console.log('Current assignments:', PHONE_ASSIGNMENTS);
        
        // TODO: Later update Twilio webhook URL to /incoming-call/{agentId}
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
        reply.status(500).send({ 
            error: 'Failed to assign agent' 
        });
    }
});

// Unassign agent from phone number
fastify.post('/api/unassign-agent', async (request, reply) => {
    try {
        const { phoneNumber } = request.body;
        
        // Remove the assignment
        delete PHONE_ASSIGNMENTS[phoneNumber];
        
        console.log(`Unassigning agent from number ${phoneNumber}`);
        console.log('Current assignments:', PHONE_ASSIGNMENTS);
        
        reply.send({ 
            success: true, 
            message: `Agent unassigned from ${phoneNumber}` 
        });
    } catch (error) {
        console.error('Error unassigning agent:', error);
        reply.status(500).send({ 
            error: 'Failed to unassign agent' 
        });
    }
});

// ENHANCED: API endpoint to update agent-specific configuration
fastify.route({
    method: ['POST', 'PUT'],
    url: '/api/update-prompt/:agentId?',
    handler: async (request, reply) => {
        try {
            const agentId = request.params.agentId || 'default';
            const { prompt, temperature, speaksFirst, greetingMessage } = request.body;
            
            if (!prompt || typeof prompt !== 'string') {
                return reply.status(400).send({ 
                    error: 'Invalid prompt. Must be a non-empty string.' 
                });
            }
            
            // Ensure agent config exists
            if (!AGENT_CONFIGS[agentId]) {
                AGENT_CONFIGS[agentId] = { ...AGENT_CONFIGS['default'] };
            }
            
            const oldConfig = { ...AGENT_CONFIGS[agentId] };
            
            // Update agent-specific configuration
            AGENT_CONFIGS[agentId].systemMessage = prompt;
            if (temperature !== undefined) {
                AGENT_CONFIGS[agentId].temperature = parseFloat(temperature);
            }
            if (speaksFirst !== undefined) {
                AGENT_CONFIGS[agentId].speaksFirst = speaksFirst;
            }
            if (greetingMessage !== undefined) {
                AGENT_CONFIGS[agentId].greetingMessage = greetingMessage;
            }
            
            console.log(`=== AGENT ${agentId.toUpperCase()} CONFIG UPDATE FROM LOVABLE ===`);
            console.log('Previous prompt:', oldConfig.systemMessage.substring(0, 100) + '...');
            console.log('NEW prompt:', AGENT_CONFIGS[agentId].systemMessage.substring(0, 100) + '...');
            console.log('Previous temperature:', oldConfig.temperature);
            console.log('NEW temperature:', AGENT_CONFIGS[agentId].temperature);
            console.log('Previous speaks first:', oldConfig.speaksFirst);
            console.log('NEW speaks first:', AGENT_CONFIGS[agentId].speaksFirst);
            console.log('Previous greeting message:', oldConfig.greetingMessage);
            console.log('NEW greeting message:', AGENT_CONFIGS[agentId].greetingMessage);
            console.log('Active connections:', activeConnections.size);
            console.log('==============================================================');
            
            reply.send({ 
                success: true, 
                message: `Agent ${agentId} configuration updated successfully`,
                agentId,
                prompt: AGENT_CONFIGS[agentId].systemMessage,
                temperature: AGENT_CONFIGS[agentId].temperature,
                speaksFirst: AGENT_CONFIGS[agentId].speaksFirst,
                greetingMessage: AGENT_CONFIGS[agentId].greetingMessage
            });
        } catch (error) {
            console.error('Error updating agent config:', error);
            reply.status(500).send({ 
                error: 'Failed to update agent configuration' 
            });
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
        temperature: config.temperature,
        speaksFirst: config.speaksFirst,
        greetingMessage: config.greetingMessage,
        activeConnections: activeConnections.size
    });
});

// Route for Twilio to handle incoming calls with agent-specific routing
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

// WebSocket route for media-stream with agent-specific configuration
fastify.register(async (fastify) => {
    fastify.get('/media-stream/:agentId?', { websocket: true }, (connection, req) => {
        const agentId = req.params.agentId || 'default';
        const agentConfig = AGENT_CONFIGS[agentId] || AGENT_CONFIGS['default'];
        
        console.log(`Client connected for agent: ${agentId}`);

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let openAiWs = null;

        // Create connection data object to track this connection
        const connectionData = { connection, openAiWs: null, agentId };

        try {
            openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${agentConfig.temperature}`, {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                },
                timeout: 30000
            });
            
            // Store the OpenAI WebSocket in connection data and add to active connections
            connectionData.openAiWs = openAiWs;
            activeConnections.add(connectionData);
            
        } catch (error) {
            console.error('Failed to create OpenAI WebSocket:', error);
            connection.close();
            return;
        }

        // Control initial session with OpenAI using agent-specific config
        const initializeSession = () => {
            console.log('=== INITIALIZING SESSION ===');
            console.log('Agent ID:', agentId);
            console.log('Using SYSTEM_MESSAGE:', agentConfig.systemMessage.substring(0, 100) + '...');
            console.log('Using VOICE:', VOICE);
            console.log('Using TEMPERATURE:', agentConfig.temperature);
            console.log('Using SPEAKS_FIRST:', agentConfig.speaksFirst);
            console.log('============================');
            
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime",
                    output_modalities: ["audio"],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: 'marin' }, // Always marin voice
                    },
                    instructions: agentConfig.systemMessage,
                    temperature: agentConfig.temperature
                },
            };
            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify(sessionUpdate));
            }
        };

        // Send initial conversation item if AI talks first using agent-specific greeting
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
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify(initialConversationItem));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
            }
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);
                if (lastAssistantItem && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }
                
                if (connection.readyState === WebSocket.OPEN) {
                    connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                    }));
                }
                
                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams
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

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
            // Check if AI should speak first using agent config
            if (agentConfig.speaksFirst === 'ai') {
                setTimeout(sendInitialConversationItem, 200);
            }
        });

        // Listen for messages from the OpenAI WebSocket
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // CRITICAL: Log full error details when responses fail
                if (response.type === 'response.done' && response.response.status === 'failed') {
                    console.log('=== RESPONSE FAILURE DETAILS ===');
                    console.log('Full response object:', JSON.stringify(response.response, null, 2));
                    if (response.response.status_details && response.response.status_details.error) {
                        console.log('Error details:', JSON.stringify(response.response.status_details.error, null, 2));
                    }
                    console.log('================================');
                }

                // Listen for the correct audio event type
                if (response.type === 'response.output_audio.delta' && response.delta) {
                    console.log('Audio delta received! Length:', response.delta.length);
                    if (connection.readyState === WebSocket.OPEN) {
                        const audioDelta = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: response.delta }
                        };
                        connection.send(JSON.stringify(audioDelta));

                        // First delta from a new response starts the elapsed time counter
                        if (!responseStartTimestampTwilio) {
                            responseStartTimestampTwilio = latestMediaTimestamp;
                            if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
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
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        // Reset start and media timestamp on a new stream
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

        // Handle connection close
        connection.on('close', () => {
            console.log('Client disconnected from media stream');
            // Remove from active connections
            activeConnections.delete(connectionData);
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
        });

        // Handle connection errors
        connection.on('error', (error) => {
            console.error('WebSocket connection error:', error);
        });

        // Handle OpenAI WebSocket close and errors
        openAiWs.on('close', (code, reason) => {
            console.log(`Disconnected from OpenAI Realtime API. Code: ${code}, Reason: ${reason}`);
            // Remove from active connections when OpenAI connection closes
            activeConnections.delete(connectionData);
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    fastify.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Error handler
fastify.setErrorHandler((error, request, reply) => {
    console.error('Server error:', error);
    reply.status(500).send({ error: 'Something went wrong!' });
});

// Start the server
const start = async () => {
    try {
        await fastify.listen({ 
            port: PORT, 
            host: '0.0.0.0'
        });
        console.log(`Server is listening on port ${PORT}`);
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

start();

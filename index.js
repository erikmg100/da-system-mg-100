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

// Constants - make these configurable
let SYSTEM_MESSAGE = process.env.SYSTEM_MESSAGE || `You are a helpful and naturally expressive AI assistant who communicates exactly like a real human would. 

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

Always sound like you're having a natural conversation with a friend. Be genuinely interested, emotionally responsive, and authentically human in every interaction.`;

const VOICE = 'marin'; // Always use marin voice
let TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.8;
let SPEAKS_FIRST = 'caller'; // 'caller' or 'ai'
let GREETING_MESSAGE = 'Hello there! How can I help you today?';
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

// ENHANCED: API endpoint to update system message with instant session updates
fastify.route({
    method: ['POST', 'PUT'],
    url: '/api/update-prompt',
    handler: async (request, reply) => {
        try {
            const { prompt, temperature, speaksFirst, greetingMessage } = request.body;
            
            if (!prompt || typeof prompt !== 'string') {
                return reply.status(400).send({ 
                    error: 'Invalid prompt. Must be a non-empty string.' 
                });
            }
            
            const oldPrompt = SYSTEM_MESSAGE;
            const oldTemperature = TEMPERATURE;
            const oldSpeaksFirst = SPEAKS_FIRST;
            const oldGreetingMessage = GREETING_MESSAGE;
            
            // Update prompt, temperature, and speaksFirst
            SYSTEM_MESSAGE = prompt;
            if (temperature !== undefined) {
                TEMPERATURE = parseFloat(temperature);
            }
            if (speaksFirst !== undefined) {
                SPEAKS_FIRST = speaksFirst;
            }
            if (greetingMessage !== undefined) {
                GREETING_MESSAGE = greetingMessage;
            }
            
            console.log('=== PROMPT, TEMPERATURE & SPEAKS FIRST UPDATE FROM LOVABLE ===');
            console.log('Previous prompt:', oldPrompt.substring(0, 100) + '...');
            console.log('NEW prompt:', SYSTEM_MESSAGE.substring(0, 100) + '...');
            console.log('Previous temperature:', oldTemperature);
            console.log('NEW temperature:', TEMPERATURE);
            console.log('Previous speaks first:', oldSpeaksFirst);
            console.log('NEW speaks first:', SPEAKS_FIRST);
            console.log('Previous greeting message:', oldGreetingMessage);
            console.log('NEW greeting message:', GREETING_MESSAGE);
            console.log('Active connections:', activeConnections.size);
            
            // UPDATE ALL ACTIVE SESSIONS IMMEDIATELY with new settings
            let updatedSessions = 0;
            activeConnections.forEach(connectionData => {
                if (connectionData.openAiWs && connectionData.openAiWs.readyState === WebSocket.OPEN) {
                    console.log('🔄 Updating active session with new settings...');
                    const sessionUpdate = {
                        type: 'session.update',
                        session: {
                            instructions: SYSTEM_MESSAGE,
                            voice: 'marin', // Always marin voice
                            temperature: TEMPERATURE, // Use updated temperature
                            type: 'realtime',
                            model: "gpt-realtime",
                            output_modalities: ["audio"],
                            audio: {
                                input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                                output: { format: { type: 'audio/pcmu' }, voice: 'marin' }, // Always marin voice
                            }
                        }
                    };
                    connectionData.openAiWs.send(JSON.stringify(sessionUpdate));
                    updatedSessions++;
                    console.log('✅ Active session updated instantly!');
                }
            });
            
            console.log(`Updated ${updatedSessions} active sessions immediately`);
            console.log('Next call will use the NEW settings');
            console.log('==============================================================');
            
            reply.send({ 
                success: true, 
                message: 'System prompt, temperature, speaks first, and greeting message updated successfully',
                prompt: SYSTEM_MESSAGE,
                temperature: TEMPERATURE,
                speaksFirst: SPEAKS_FIRST,
                greetingMessage: GREETING_MESSAGE,
                activeSessionsUpdated: updatedSessions
            });
        } catch (error) {
            console.error('Error updating settings:', error);
            reply.status(500).send({ 
                error: 'Failed to update settings' 
            });
        }
    }
});

// API endpoint to get current system message
fastify.get('/api/current-prompt', async (request, reply) => {
    reply.send({ 
        prompt: SYSTEM_MESSAGE,
        voice: VOICE,
        temperature: TEMPERATURE,
        speaksFirst: SPEAKS_FIRST,
        greetingMessage: GREETING_MESSAGE,
        activeConnections: activeConnections.size
    });
});

// Route for Twilio to handle incoming calls - NO INTRO MESSAGE
fastify.all('/incoming-call', async (request, reply) => {
    try {
        console.log('=== INCOMING CALL ===');
        console.log('Current SYSTEM_MESSAGE at call time:', SYSTEM_MESSAGE.substring(0, 100) + '...');
        console.log('Voice:', VOICE);
        console.log('Speaks First:', SPEAKS_FIRST);
        console.log('====================');
        
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Connect>
                                      <Stream url="wss://${request.headers.host}/media-stream" />
                                  </Connect>
                              </Response>`;
        reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        console.error('Error handling incoming call:', error);
        reply.status(500).send('Internal Server Error');
    }
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected to media stream');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let openAiWs = null;

        // Create connection data object to track this connection
        const connectionData = { connection, openAiWs: null };

        try {
            openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`, {
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

        // Control initial session with OpenAI
        const initializeSession = () => {
            console.log('=== INITIALIZING SESSION ===');
            console.log('Using SYSTEM_MESSAGE:', SYSTEM_MESSAGE.substring(0, 100) + '...');
            console.log('Using VOICE:', VOICE);
            console.log('Using SPEAKS_FIRST:', SPEAKS_FIRST);
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
                    instructions: SYSTEM_MESSAGE,
                },
            };
            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify(sessionUpdate));
            }
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: `Say this exact greeting to the caller: "${GREETING_MESSAGE}"`
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
            // Check if AI should speak first
            if (SPEAKS_FIRST === 'ai') {
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

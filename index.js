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
fastify.register(fastifyCors, { 
    origin: [
        'https://*.lovable.dev', 
        'https://lovable.dev',
        /\.lovable\.dev$/,
        'http://localhost:3000',
        'http://localhost:5173'
    ],
    methods: ['GET', 'PUT', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
});

// Constants - make these configurable
let SYSTEM_MESSAGE = process.env.SYSTEM_MESSAGE || 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.';
const VOICE = process.env.VOICE || 'alloy';
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.8;
const PORT = process.env.PORT || 3000; // Add fallback port

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

// API endpoint to update system message
fastify.post('/api/update-prompt', async (request, reply) => {
    try {
        const { prompt } = request.body;
        if (!prompt || typeof prompt !== 'string') {
            return reply.status(400).send({ 
                error: 'Invalid prompt. Must be a non-empty string.' 
            });
        }
        
        SYSTEM_MESSAGE = prompt;
        fastify.log.info('System message updated:', prompt);
        
        reply.send({ 
            success: true, 
            message: 'System prompt updated successfully',
            prompt: SYSTEM_MESSAGE 
        });
    } catch (error) {
        fastify.log.error('Error updating prompt:', error);
        reply.status(500).send({ 
            error: 'Failed to update prompt' 
        });
    }
});

// API endpoint to get current system message
fastify.get('/api/current-prompt', async (request, reply) => {
    reply.send({ 
        prompt: SYSTEM_MESSAGE,
        voice: VOICE,
        temperature: TEMPERATURE
    });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    try {
        const host = request.headers.host;
        const protocol = request.headers['x-forwarded-proto'] || 'https';
        
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                              <Response>
                                  <Connect>
                                      <Stream url="${protocol}://${host}/media-stream" />
                                  </Connect>
                              </Response>`;
        reply.type('text/xml').send(twimlResponse);
    } catch (error) {
        fastify.log.error('Error handling incoming call:', error);
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

        try {
            openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`, {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                },
                timeout: 30000
            });
        } catch (error) {
            console.error('Failed to create OpenAI WebSocket:', error);
            connection.close();
            return;
        }

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime",
                    output_modalities: ["audio"],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: VOICE },
                    },
                    instructions: SYSTEM_MESSAGE,
                },
            };
            console.log('Sending session update');
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
                            text: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"'
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
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event');
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
            // Uncomment the following line to have AI speak first:
            // sendInitialConversationItem();
        });

        // Listen for messages from the OpenAI WebSocket
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`);
                }
                
                if (response.type === 'response.output_audio.delta' && response.delta) {
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
                console.error('Error processing OpenAI message:', error);
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
                console.error('Error parsing message:', error);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            console.log('Client disconnected from media stream');
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
    fastify.log.error(error);
    reply.status(500).send({ error: 'Something went wrong!' });
});

// Start the server
const start = async () => {
    try {
        await fastify.listen({ 
            port: PORT, 
            host: '0.0.0.0' // Changed from '::' to '0.0.0.0' for better Railway compatibility
        });
        console.log(`Server is listening on port ${PORT}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();

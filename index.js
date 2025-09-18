import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
• Ask follow-up questions naturally: "When did this happened?" "How are you feeling about all this?"
• Clarify when needed: "Just to make sure I understand correctly..."

CONVERSATION FLOW:
• Start with understanding their situation
• Show empathy for their concerns  
• Gather necessary information conversationally
• Explain next steps in simple terms
• End with reassurance and clear action items

Remember: You're not just collecting information - you're the first person showing them that someone cares about their problem and wants to help.`,
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

// Audio buffer management for Whisper transcription
class AudioBuffer {
    constructor(callId) {
        this.callId = callId;
        this.chunks = [];
        this.isRecording = false;
        this.lastTranscriptionTime = 0;
        this.transcriptionInterval = 10000; // Transcribe every 10 seconds
        this.tempDir = path.join(__dirname, 'temp');
        
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    addChunk(audioData) {
        if (this.isRecording) {
            // Convert base64 to buffer and store
            const buffer = Buffer.from(audioData, 'base64');
            this.chunks.push(buffer);
            
            // Check if it's time to transcribe
            const now = Date.now();
            if (now - this.lastTranscriptionTime >= this.transcriptionInterval) {
                this.transcribeAndClear();
            }
        }
    }

    startRecording() {
        this.isRecording = true;
        this.lastTranscriptionTime = Date.now();
        console.log(`Started audio recording for call ${this.callId}`);
    }

    stopRecording() {
        this.isRecording = false;
        if (this.chunks.length > 0) {
            this.transcribeAndClear();
        }
        console.log(`Stopped audio recording for call ${this.callId}`);
    }

    async transcribeAndClear() {
        if (this.chunks.length === 0) return;

        try {
            // Combine all audio chunks
            const audioBuffer = Buffer.concat(this.chunks);
            
            // Save to temporary file (Whisper needs a file, not raw buffer)
            const tempFilePath = path.join(this.tempDir, `${this.callId}_${Date.now()}.wav`);
            
            // Convert PCM µ-law to WAV format that Whisper can process
            const wavBuffer = this.convertPcmuToWav(audioBuffer);
            fs.writeFileSync(tempFilePath, wavBuffer);
            
            // Send to Whisper for transcription
            const transcript = await this.transcribeWithWhisper(tempFilePath);
            
            if (transcript && transcript.trim()) {
                console.log(`\n=== WHISPER TRANSCRIPT (Call ${this.callId}) ===`);
                console.log(transcript);
                console.log(`============================================\n`);
                
                // Here you can save to database, send to webhook, etc.
                await this.saveTranscript(transcript);
            }
            
            // Clean up
            this.chunks = [];
            this.lastTranscriptionTime = Date.now();
            
            // Delete temp file
            fs.unlinkSync(tempFilePath);
            
        } catch (error) {
            console.error('Error transcribing audio:', error);
            this.chunks = []; // Clear chunks even on error
        }
    }

    convertPcmuToWav(pcmuBuffer) {
        // This is a simplified conversion - you might want to use a proper audio library
        // For now, we'll create a basic WAV header for the PCM data
        const wavHeader = Buffer.alloc(44);
        const dataLength = pcmuBuffer.length;
        
        // WAV header
        wavHeader.write('RIFF', 0);
        wavHeader.writeInt32LE(36 + dataLength, 4);
        wavHeader.write('WAVE', 8);
        wavHeader.write('fmt ', 12);
        wavHeader.writeInt32LE(16, 16);
        wavHeader.writeInt16LE(1, 20); // PCM format
        wavHeader.writeInt16LE(1, 22); // Mono
        wavHeader.writeInt32LE(8000, 24); // Sample rate
        wavHeader.writeInt32LE(8000, 28); // Byte rate
        wavHeader.writeInt16LE(1, 32); // Block align
        wavHeader.writeInt16LE(8, 34); // Bits per sample
        wavHeader.write('data', 36);
        wavHeader.writeInt32LE(dataLength, 40);
        
        return Buffer.concat([wavHeader, pcmuBuffer]);
    }

    async transcribeWithWhisper(filePath) {
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(filePath));
            formData.append('model', 'whisper-1');
            formData.append('language', 'en'); // Adjust as needed
            
            const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    ...formData.getHeaders()
                },
                body: formData
            });
            
            if (!response.ok) {
                throw new Error(`Whisper API error: ${response.status} ${response.statusText}`);
            }
            
            const result = await response.json();
            return result.text;
        } catch (error) {
            console.error('Whisper transcription error:', error);
            return null;
        }
    }

    async saveTranscript(transcript) {
        // Save transcript to file or database
        const logFile = path.join(__dirname, 'transcripts', `${this.callId}.txt`);
        const transcriptDir = path.dirname(logFile);
        
        if (!fs.existsSync(transcriptDir)) {
            fs.mkdirSync(transcriptDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${transcript}\n`;
        
        fs.appendFileSync(logFile, logEntry);
    }

    cleanup() {
        // Clean up any remaining chunks
        this.chunks = [];
    }
}

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
            const { prompt, speaksFirst, greetingMessage } = request.body;
            
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
            if (speaksFirst !== undefined) {
                AGENT_CONFIGS[agentId].speaksFirst = speaksFirst;
            }
            if (greetingMessage !== undefined) {
                AGENT_CONFIGS[agentId].greetingMessage = greetingMessage;
            }
            
            console.log(`=== AGENT ${agentId.toUpperCase()} CONFIG UPDATE FROM LOVABLE ===`);
            console.log('Previous prompt:', oldConfig.systemMessage.substring(0, 100) + '...');
            console.log('NEW prompt:', AGENT_CONFIGS[agentId].systemMessage.substring(0, 100) + '...');
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
        let audioBuffer = null; // For Whisper transcription

        // Create connection data object to track this connection
        const connectionData = { connection, openAiWs: null, agentId };

        try {
            openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
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
                    instructions: agentConfig.systemMessage
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
                        
                        // Add audio to Whisper buffer for transcription
                        if (audioBuffer) {
                            audioBuffer.addChunk(data.media.payload);
                        }
                        
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
                        
                        // Initialize audio buffer for Whisper transcription
                        const callId = `${agentId}_${streamSid}_${Date.now()}`;
                        audioBuffer = new AudioBuffer(callId);
                        audioBuffer.startRecording();
                        
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
            
            // Stop audio recording and transcribe final chunks
            if (audioBuffer) {
                audioBuffer.stopRecording();
                audioBuffer.cleanup();
            }
            
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

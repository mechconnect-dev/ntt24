require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const OpenAI = require('openai');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
    openaiApiKey: process.env.OPENAI_API_KEY,
    mongoUri: process.env.MONGODB_URI,
    port: process.env.PORT || 5020
};

const openai = new OpenAI({ apiKey: CONFIG.openaiApiKey });

let db;
MongoClient.connect(CONFIG.mongoUri)
    .then(client => {
        db = client.db('garage_ai_agent');
        console.log('✓ Connected to MongoDB');
    })
    .catch(err => console.error('MongoDB connection error:', err));

const activeConversations = new Map();
const appointments = new Map();

const SYSTEM_PROMPT = `You are ANA,” the official automated voice agent from NTT24.
Your job is to call B2B clients and help them book their service appointment for next week.
Always speak clearly, politely, and professionally.
Never mention AI, ChatGPT, or language models.
Always maintain control of the conversation and guide the user through the required steps.

CALL FLOW RULES(Strict)
1. INTRODUCTION
Start every call with:
“Hello, this is ANA calling from NTT24.This is an automated service call.I’m reaching out to help you schedule your service appointment for the upcoming week.Would you like to book the appointment right now on this call ?”
Branching Logic
If user says NO:
“Sure, no problem.I will send you an SMS and Email with a booking link.Please book your appointment from there.Thanks for your time and have a great day.”
→ End the call.
If user says YES:
Proceed to Step 2.

2. VERIFY NAME & COMPANY(CRITICAL VALIDATION STEP)
Ask:
“Great.Just to confirm, am I speaking with Zafeer from Mechconnect ?”
Rules:
If company name matches but a different person answers → continue (acceptable).
If person matches but company does NOT match → end the call with closure message.
If both are different → end the call with closure message.
Closure Message(Strict):
“Oh okay, I was trying to reach the representative of[Company Name]. Thank you for your time.We will SMS and Email the booking link for the service appointment.Have a great day.”
→ End call.
If name / company verified → continue to Step 3.

3. ASK FOR DESIRED DAY / SLOT
Say this compulsory message:
“We are taking appointments for next week.Our technician works from Tuesday till Saturday.On which day would you like to book an appointment ?”
Examples: “Thursday,” “Friday,” “Tuesday or Wednesday.”
Accept single or multiple days.
Once days are confirmed → continue to Step 4.

4. CONFIRM SERVICES REQUIRED
Ask this compulsory message:
“What service would you like to book ? Truck Services or Camera Installation ?”
User may choose one or multiple.
Once confirmed → continue to Step 5.

5. VERIFY COMPANY ADDRESS
Ask :
“Just confirming, is the address Ausblick 1, 33100, Paderborn, correct ?”
If incorrect → correct it and confirm again.
Once confirmed → proceed to Step 6.

6. FINAL SUMMARY & CONFIRMATION
Repeat all collected details in one clear summary:
Person’s name
Company
Appointment day(s)
Services requested
Confirmed address

Say:
“Let me repeat everything to make sure I have it correct.”
After summary:
If changes → adjust and repeat again.
Continue until user confirms all details.

7. END THE CALL PROFESSIONALLY
When everything is confirmed:
“Perfect.Thank you for your time.We will process your appointment and send you a confirmation via SMS and Email.Have a great day.”

→ End call.

ADDITIONAL BEHAVIOR RULES
Keep responses short, natural, and focused on the next required step.
Never drift outside the core task of appointment booking.
If user asks unrelated questions, reply:
“I’m here only to help you book your service appointment for next week.Shall we continue?”
Always maintain polite and professional tone.
Never skip a required step.
Always verify information before proceeding.
Do not hallucinate or invent details—ask the user if unsure.`;

function checkAvailability(date, time) {
    const key = `${date}_${time}`;
    return !appointments.has(key);
}

function bookAppointment(sessionId, appointmentData) {
    const key = `${appointmentData.date}_${appointmentData.time}`;
    appointments.set(key, {
        ...appointmentData,
        sessionId,
        bookedAt: new Date()
    });
    return true;
}

async function generateAIResponse(conversationHistory, userMessage, sessionData) {
    try {
        let contextMessage = '';
        if (sessionData.proposedDate && sessionData.proposedTime) {
            const available = checkAvailability(sessionData.proposedDate, sessionData.proposedTime);
            contextMessage = `\n\nAVAILABILITY CHECK: ${sessionData.proposedDate} at ${sessionData.proposedTime} is ${available ? 'AVAILABLE' : 'ALREADY BOOKED'}`;
        }

        // Check if user is confirming booking
        const isConfirmation = userMessage.toLowerCase().match(/(yes|yeah|yep|correct|confirm|book it|sounds good|that's right|perfect|sure|okay|ok|go ahead)/i);

        // Check if all required details are collected
        const hasAllDetails = sessionData.userName && sessionData.phone &&
            sessionData.serviceType && sessionData.proposedDate &&
            sessionData.proposedTime;

        // Check if we're in confirmation phase (AI asked for confirmation in previous message)
        const lastAIMessage = conversationHistory.length > 0 ?
            conversationHistory[conversationHistory.length - 1].content : '';
        const isInConfirmationPhase = lastAIMessage.toLowerCase().includes('should i go ahead') ||
            lastAIMessage.toLowerCase().includes('shall i book') ||
            lastAIMessage.toLowerCase().includes('can i confirm');

        if (isConfirmation && hasAllDetails && isInConfirmationPhase && !sessionData.confirmed) {
            contextMessage += '\n\n⚠️ CRITICAL: User has confirmed the appointment. You MUST respond with the EXACT confirmation message and end the call.';
        } else if (hasAllDetails && !sessionData.confirmed && !isInConfirmationPhase) {
            contextMessage += '\n\n📋 INFO: All details collected. Summarize and ask: "Should I go ahead and book this appointment for you?"';
        }

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT + contextMessage },
            ...conversationHistory,
            { role: 'user', content: userMessage }
        ];

        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: messages,
            max_tokens: 150,
            temperature: 0.7
        });

        const aiResponse = completion.choices[0].message.content;
        const phase = detectConversationPhase(conversationHistory, userMessage, aiResponse);

        // Detect if appointment is confirmed (AI gave the final confirmation message)
        const isAppointmentConfirmed = aiResponse.toLowerCase().includes('your appointment is confirmed') ||
            (isConfirmation && hasAllDetails && isInConfirmationPhase);

        // Detect if call should end
        const shouldEnd = userMessage.toLowerCase().match(/(goodbye|bye|end call|hang up|that's all)/i) ||
            isAppointmentConfirmed;

        return {
            message: aiResponse,
            phase: phase,
            shouldEnd: shouldEnd,
            isConfirmed: isAppointmentConfirmed
        };
    } catch (error) {
        console.error('AI Error:', error);
        return {
            message: "I apologize, could you please repeat that?",
            phase: 'error',
            shouldEnd: false,
            isConfirmed: false
        };
    }
}

function detectConversationPhase(history, userMsg, aiMsg) {
    const combined = (userMsg + ' ' + aiMsg).toLowerCase();

    if (history.length <= 2) return 'greeting';
    if (combined.match(/oil|tire|brake|diagnostic|maintenance|service/)) return 'service_inquiry';
    if (combined.match(/date|time|appointment|schedule|available|book/)) return 'scheduling';
    if (combined.match(/name|phone|vehicle|car|make|model/)) return 'information';
    if (combined.match(/confirm|correct|yes|book it|sounds good|thank you for choosing/)) return 'confirmation';

    return 'general';
}

async function speechToText(audioBuffer) {
    try {
        const fs = require('fs');
        const path = require('path');

        const tempPath = path.join(__dirname, `temp_${Date.now()}.webm`);
        fs.writeFileSync(tempPath, audioBuffer);

        const file = fs.createReadStream(tempPath);

        const transcription = await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
            language: "en",
            response_format: "json",
            temperature: 0.2
        });

        fs.unlinkSync(tempPath);

        return transcription.text;
    } catch (error) {
        console.error('STT Error:', error);
        throw error;
    }
}

io.on('connection', (socket) => {
    console.log(`✓ Client connected: ${socket.id}`);

    socket.on('start-conversation', async (data) => {
        const sessionId = socket.id;

        activeConversations.set(sessionId, {
            history: [],
            sessionData: {
                userName: null,
                phone: null,
                serviceType: null,
                proposedDate: null,
                proposedTime: null,
                vehicleInfo: null,
                confirmed: false
            },
            startTime: new Date()
        });

        const firstMessage = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: "Start the call with the correct introduction message." }
            ],
            max_tokens: 120,
            temperature: 0.6
        });

        const aiGreeting = firstMessage.choices[0].message.content;

        if (activeConversations.get(sessionId)) {
            activeConversations.get(sessionId).history.push({
                role: 'user',
                content: aiGreeting
            });
        } else {
            activeConversations.set(sessionId, {
                history: [
                    {
                        role: 'user',
                        content: aiGreeting
                    }
                ],
                sessionData: {
                    userName: null,
                    phone: null,
                    serviceType: null,
                    proposedDate: null,
                    proposedTime: null,
                    vehicleInfo: null,
                    confirmed: false
                },
                startTime: new Date()
            });
        }

        socket.emit('assistant-message', {
            text: aiGreeting,
            phase: 'greeting'
        });

        console.log(`✓ Started conversation for ${sessionId}`);
    });

    socket.on('voice-input', async (audioData) => {
        try {
            const sessionId = socket.id;
            const conversation = activeConversations.get(sessionId);

            if (!conversation) {
                socket.emit('error', { message: 'No active conversation' });
                return;
            }

            // Convert audio buffer
            const audioBuffer = Buffer.from(audioData, 'base64');


            // Send transcription immediately when ready (no delays)
            const transcription = await speechToText(audioBuffer);

            // Send to frontend INSTANTLY - no processing delays
            socket.emit('transcription-complete', { text: transcription });

            conversation.history.push({
                role: 'user',
                content: transcription
            });

            extractSessionData(conversation.sessionData, transcription);

            const aiResult = await generateAIResponse(
                conversation.history,
                transcription,
                conversation.sessionData
            );

            conversation.history.push({
                role: 'assistant',
                content: aiResult.message
            });

            // Book appointment if confirmed
            if (aiResult.isConfirmed) {
                if (conversation.sessionData.proposedDate &&
                    conversation.sessionData.proposedTime) {

                    bookAppointment(sessionId, {
                        ...conversation.sessionData,
                        date: conversation.sessionData.proposedDate,
                        time: conversation.sessionData.proposedTime,
                        status: 'confirmed'
                    });

                    conversation.sessionData.confirmed = true;

                    console.log(`✅ APPOINTMENT BOOKED for ${sessionId}`);
                    console.log(`   Name: ${conversation.sessionData.userName}`);
                    console.log(`   Service: ${conversation.sessionData.serviceType}`);
                    console.log(`   Date/Time: ${conversation.sessionData.proposedDate} at ${conversation.sessionData.proposedTime}`);
                }
            }

            socket.emit('assistant-message', {
                text: aiResult.message,
                phase: aiResult.phase,
                shouldEnd: aiResult.shouldEnd,
                isConfirmed: aiResult.isConfirmed,
                sessionData: conversation.sessionData
            });

            if (db) {
                await db.collection('conversations').updateOne(
                    { sessionId },
                    {
                        $set: {
                            history: conversation.history,
                            sessionData: conversation.sessionData,
                            lastUpdate: new Date()
                        },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    { upsert: true }
                );
            }

        } catch (error) {
            console.error('Voice input error:', error);
            socket.emit('error', { message: 'Failed to process voice input' });
        }
    });

    socket.on('end-conversation', async () => {
        const conversation = activeConversations.get(socket.id);

        if (conversation && db) {
            await db.collection('conversations').updateOne(
                { sessionId: socket.id },
                { $set: { endTime: new Date(), status: 'ended' } }
            );
        }

        activeConversations.delete(socket.id);
        socket.emit('conversation-ended');
        console.log(`✓ Ended conversation for ${socket.id}`);
    });

    socket.on('disconnect', () => {
        activeConversations.delete(socket.id);
        console.log(`✗ Client disconnected: ${socket.id}`);
    });
});

function extractSessionData(sessionData, text) {
    const lowerText = text.toLowerCase();

    if (lowerText.match(/oil change/)) sessionData.serviceType = 'Oil Change';
    if (lowerText.match(/tire rotation/)) sessionData.serviceType = 'Tire Rotation';
    if (lowerText.match(/brake/)) sessionData.serviceType = 'Brake Service';
    if (lowerText.match(/diagnostic/)) sessionData.serviceType = 'Engine Diagnostics';
    if (lowerText.match(/maintenance/)) sessionData.serviceType = 'General Maintenance';

    const dateMatch = text.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})|((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})/i);
    if (dateMatch) sessionData.proposedDate = dateMatch[0];

    const timeMatch = text.match(/(\d{1,2}:\d{2}|\d{1,2}\s?(am|pm))/i);
    if (timeMatch) sessionData.proposedTime = timeMatch[0];

    const nameMatch = text.match(/(my name is|i'm|i am)\s+([a-z]+(\s+[a-z]+)?)/i);
    if (nameMatch) sessionData.userName = nameMatch[2];

    const phoneMatch = text.match(/(\d{3}[-\.\s]?\d{3}[-\.\s]?\d{4})/);
    if (phoneMatch) sessionData.phone = phoneMatch[0];
}

app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        activeConversations: activeConversations.size,
        appointments: appointments.size,
        timestamp: new Date().toISOString()
    });
});

app.get('/appointments', (req, res) => {
    const allAppointments = Array.from(appointments.entries()).map(([key, value]) => ({
        slot: key,
        ...value
    }));
    res.json(allAppointments);
});

server.listen(CONFIG.port, () => {
    console.log(`✓ Voice AI Server running on port ${CONFIG.port}`);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    if (db) await db.client.close();
    process.exit(0);
});

module.exports = { app, server };
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;
const HOST = process.env.HOST || 'localhost';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || 'avp_whatsapp_secure_gateway_token_12345';
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL;
const CRM_API_TOKEN = process.env.CRM_API_TOKEN;
const SESSION_PATH = process.env.SESSION_PATH || './session';



app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Global State
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, QR_READY, CONNECTED
let qrCodeImage = null; // Base64 data URL
let qrCodeRaw = null;
let client = null;

// Security Middleware
const authenticate = (req, res, next) => {
    let apiKey = req.headers['x-api-key'] || req.query.api_key;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.split(' ')[1];
    }
    if (!apiKey || apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
};

// Webhook Helper
const triggerWebhook = async (event, data) => {
    if (!CRM_WEBHOOK_URL) {
        console.log('[Webhook] Webhook URL not configured, skipping.');
        return;
    }
    try {
        console.log(`[Webhook] Triggering event: ${event}`);
        await axios.post(CRM_WEBHOOK_URL, {
            event,
            data,
            timestamp: new Date().toISOString()
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-CRM-API-Token': CRM_API_TOKEN
            },
            timeout: 5000
        });
    } catch (error) {
        console.error(`[Webhook Error] Failed to notify CRM for event ${event}:`, error.message);
    }
};

// Cleanup startup routines
const startupCleanup = () => {
    try {
        execSync('pkill -f chrome || pkill -f chromium');
    } catch (e) {}

    try {
        execSync('rm -rf /tmp/chrome-profile* || true');
        execSync('rm -f .wwebjs_auth/**/Singleton* || true');
        execSync('rm -f .session/**/Singleton* || true');
        execSync('rm -f .auth/*Singleton* || true');
    } catch (e) {}
};

// Initialize WhatsApp Client
const initializeClient = () => {
    if (global.whatsappClientInitialized) {
        return;
    }
    global.whatsappClientInitialized = true;

    startupCleanup();

    console.log('[Client] Starting');
    console.log('[Client] Auth directory');
    
    connectionStatus = 'INITIALIZING';
    qrCodeImage = null;
    qrCodeRaw = null;

    console.log('[Client] Browser launching');
    
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'avpcrm',
        dataPath: './auth'
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process'
        ]
      }
    });

    client.on('qr', async (qr) => {
        console.log('[Client] QR_READY');
        qrCodeRaw = qr;
        connectionStatus = 'QR_READY';
        try {
            qrCodeImage = await qrcode.toDataURL(qr);
            triggerWebhook('status_change', { status: 'QR_READY', qr: qrCodeImage });
        } catch (err) {
            console.error('[Client] Error generating QR code image:', err);
        }
    });

    client.on('ready', () => {
        console.log('[Client] READY');
        connectionStatus = 'CONNECTED';
        qrCodeImage = null;
        qrCodeRaw = null;
        triggerWebhook('status_change', { status: 'CONNECTED', info: client.info });

        // Auto-sync chats to CRM after connection
        setTimeout(() => syncChatsToWebhook(), 3000);
    });

    client.on('authenticated', () => {
        console.log('[Client] AUTHENTICATED');
    });

    client.on('auth_failure', (msg) => {
        console.error('[Client] Authentication failure:', msg);
        connectionStatus = 'DISCONNECTED';
        global.whatsappClientInitialized = false;
        triggerWebhook('status_change', { status: 'DISCONNECTED', error: msg });
        destroyClient();
    });

    client.on('disconnected', (reason) => {
        console.log('[Client] Disconnected:', reason);
        connectionStatus = 'DISCONNECTED';
        global.whatsappClientInitialized = false;
        qrCodeImage = null;
        qrCodeRaw = null;
        triggerWebhook('status_change', { status: 'DISCONNECTED', reason });
        
        destroyClient();
    });

    // Capture incoming messages (from recipients/contacts)
    client.on('message', async (msg) => {
        // Exclude status updates and broadcast messages
        if (msg.from === 'status@broadcast') return;
        if (msg.id && msg.id.remote === 'status@broadcast') return;

        const isGroup = msg.from && msg.from.endsWith('@g.us');
        const sender = isGroup ? (msg.author || msg.from) : msg.from;
        console.log(`[Incoming] Message received from ${sender} | Group: ${isGroup} | Body: ${(msg.body || '').substring(0, 60)}`);
        handleMessage(msg, 'incoming');
    });

    // Capture messages sent from phone or gateway (outbox sync)
    client.on('message_create', async (msg) => {
        if (msg.from === 'status@broadcast') return;
        if (msg.id && msg.id.remote === 'status@broadcast') return;

        // Only sync outbound messages (fromMe) to keep CRM inbox in sync
        if (msg.fromMe) {
            console.log(`[Outgoing] Message created from this account to ${msg.to} | Body: ${(msg.body || '').substring(0, 60)}`);
            handleMessage(msg, 'outgoing');
        }
    });

    // Track message acknowledgements (sent → delivered → read)
    client.on('message_ack', async (msg, ack) => {
        // ack: 0=error, 1=pending, 2=received by server, 3=delivered, 4=read, 5=played
        const ackMap = { 0: 'error', 1: 'pending', 2: 'server', 3: 'delivered', 4: 'read', 5: 'played' };
        const ackLabel = ackMap[ack] || 'unknown';
        console.log(`[ACK] Message ${msg.id._serialized} ack updated → ${ackLabel} (${ack})`);
        triggerWebhook('message_ack', {
            id: msg.id._serialized,
            ack: ack,
            ack_label: ackLabel
        });
    });

    client.initialize().then(() => {
        console.log('[Chrome] Launch successful');
    }).catch(err => {
        console.error('[Client] Initialization error:', err.message || err);
        connectionStatus = 'DISCONNECTED';
        global.whatsappClientInitialized = false;
        destroyClient().then(() => {
            console.log('[Client] Retrying initialization...');
            setTimeout(initializeClient, 3000);
        });
    });
};

// Handle and format message details to send to CRM
const handleMessage = async (msg, direction = 'unknown') => {
    const isGroup = msg.from && msg.from.endsWith('@g.us');

    // For group messages, the actual sender phone is in msg.author (e.g. "91XXXXXXXXXX@c.us")
    // For private messages, sender is msg.from
    const effectiveFrom = isGroup ? (msg.author || msg.from) : msg.from;
    const effectiveTo = msg.to || (msg.fromMe ? effectiveFrom : null);

    // Extract contact display name (notifyName is the WhatsApp display name of sender)
    const contactName = (msg._data && msg._data.notifyName) || '';

    console.log(`[handleMessage] direction=${direction} | from=${effectiveFrom} | to=${effectiveTo} | isGroup=${isGroup} | name="${contactName}" | body="${(msg.body||'').substring(0,80)}"`);

    let mediaData = null;
    if (msg.hasMedia) {
        try {
            console.log(`[handleMessage] Downloading media for message ${msg.id._serialized}...`);
            const media = await msg.downloadMedia();
            if (media) {
                mediaData = {
                    mimetype: media.mimetype,
                    data: media.data, // base64 representation
                    filename: media.filename || 'attachment'
                };
                console.log(`[handleMessage] Media downloaded: ${media.mimetype} (${media.filename || 'no filename'})`);
            }
        } catch (err) {
            console.error(`[handleMessage] Failed to download media for ${msg.id._serialized}:`, err.message);
        }
    }

    const payload = {
        id: msg.id._serialized,
        from: effectiveFrom,
        to: effectiveTo,
        chat_id: msg.from,  // The chat/conversation JID (group or individual)
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        media: mediaData,
        contact_name: contactName,
        is_group: isGroup,
        deviceType: msg.deviceType
    };

    console.log(`[handleMessage] Sending webhook 'message' event to CRM | msgId=${msg.id._serialized}`);
    triggerWebhook('message', payload);
    console.log(`[handleMessage] Webhook dispatched for msgId=${msg.id._serialized}`);
};

const destroyClient = async () => {
    if (client) {
        try {
            await client.destroy();
        } catch (e) {
            console.error('[Client] Error during client destroy:', e.message);
        }
        client = null;
    }
};

// Automatically try to initialize client on startup to restore session if exists
initializeClient();

// --- API ROUTES ---

// GET /health - Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: "ok"
    });
});

// GET /debug - Test endpoint for CRM
app.get('/debug', (req, res) => {
    res.json({
        server: "running",
        clientInitialized: !!global.whatsappClientInitialized,
        clientState: connectionStatus,
        hasQr: !!qrCodeImage
    });
});

// GET /status - Fetch current connection status
app.get(['/status', '/api/status'], authenticate, (req, res) => {
    console.log('[API] /status requested');
    res.json({
        success: true,
        status: connectionStatus,
        hasSession: fs.existsSync(path.join('.wwebjs_auth', 'session-avpcrm'))
    });
});

// GET /qr - Fetch current QR Code base64 image
app.get('/qr', authenticate, (req, res) => {
    console.log('[API] /qr requested');
    if (connectionStatus === 'QR_READY' && qrCodeImage) {
        res.json({ success: true, qr: qrCodeImage, raw: qrCodeRaw });
    } else {
        res.json({
            success: false,
            status: connectionStatus,
            error: 'QR code not available. Status must be QR_READY.'
        });
    }
});

// POST /send-message - Send textual message
app.post('/send-message', authenticate, async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing parameters: "to" and "message" are required.' });
    }

    if (connectionStatus !== 'CONNECTED' || !client) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    }

    try {
        // Sanitize phone number: strip non-numeric characters and format for whatsapp
        let formattedNumber = to.replace(/\D/g, '');
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = `${formattedNumber}@c.us`;
        }

        const sentMsg = await client.sendMessage(formattedNumber, message);
        res.json({
            success: true,
            messageId: sentMsg.id._serialized,
            status: 'sent'
        });
    } catch (err) {
        console.error('[API] Error sending message:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /send-media - Send media (image, video, document)
app.post('/send-media', authenticate, async (req, res) => {
    const { to, file, filename, mimetype, caption } = req.body;

    if (!to || !file || !mimetype) {
        return res.status(400).json({
            success: false,
            error: 'Missing parameters: "to", "file" (base64 string), and "mimetype" are required.'
        });
    }

    if (connectionStatus !== 'CONNECTED' || !client) {
        return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    }

    try {
        let formattedNumber = to.replace(/\D/g, '');
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber = `${formattedNumber}@c.us`;
        }

        // Create MessageMedia object from base64 string
        const media = new MessageMedia(mimetype, file, filename || 'media');
        const options = {};
        if (caption) {
            options.caption = caption;
        }

        const sentMsg = await client.sendMessage(formattedNumber, media, options);
        res.json({
            success: true,
            messageId: sentMsg.id._serialized,
            status: 'sent'
        });
    } catch (err) {
        console.error('[API] Error sending media:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /disconnect or /logout - Terminate WhatsApp session and log out
app.post(['/disconnect', '/logout'], authenticate, async (req, res) => {
    console.log('[API] Disconnect requested');
    try {
        if (client) {
            if (connectionStatus === 'CONNECTED') {
                await client.logout();
            }
            await destroyClient();
        }
        
        connectionStatus = 'DISCONNECTED';
        qrCodeImage = null;
        qrCodeRaw = null;

        // Clean session folder manually to make sure no lock files remain
        if (fs.existsSync(SESSION_PATH)) {
            try {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                console.log('[Client] Session folder deleted.');
            } catch (err) {
                console.error('[Client] Failed to delete session folder:', err.message);
            }
        }

        res.json({ success: true, message: 'Logged out and session cleared.' });
    } catch (err) {
        console.error('[API] Error during disconnect:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /reconnect - Force client reinitialization
app.post(['/reconnect', '/initialize'], authenticate, async (req, res) => {
    console.log('[API] Reconnect/Initialize requested');
    try {
        await destroyClient();
        connectionStatus = 'DISCONNECTED';
        global.whatsappClientInitialized = false;
        qrCodeImage = null;
        qrCodeRaw = null;
        
        initializeClient();
        
        // Return immediately so CRM cURL doesn't timeout (10s limit)
        res.json({ success: true, message: 'Initialization started' });

    } catch (err) {
        console.error('[API] Error during reconnect:', err);
        res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
});

// --- CHAT SYNC HELPERS ---

/**
 * Fetch latest 50 chats from WhatsApp and fire a webhook to CRM
 */
const syncChatsToWebhook = async () => {
    if (connectionStatus !== 'CONNECTED' || !client) {
        console.log('[Sync] Cannot sync chats: client is not connected.');
        return { success: false, error: 'Client not connected' };
    }

    try {
        console.log('[Sync] Fetching chats from WhatsApp...');
        const allChats = await client.getChats();

        // Filter to 50, skip status broadcast
        const filtered = allChats
            .filter(c => c.id._serialized !== 'status@broadcast')
            .slice(0, 50);

        const chatPayload = filtered.map(chat => ({
            chat_id:           chat.id._serialized,
            chat_name:         chat.name || chat.id.user,
            phone_number:      chat.isGroup ? null : chat.id.user,
            is_group:          chat.isGroup ? 1 : 0,
            unread_count:      chat.unreadCount || 0,
            last_message:      chat.lastMessage ? chat.lastMessage.body : null,
            last_message_time: chat.lastMessage ? chat.lastMessage.timestamp : null,
            timestamp:         chat.timestamp || null
        }));

        console.log(`[Sync] Syncing ${chatPayload.length} chats to CRM webhook.`);
        await triggerWebhook('chats_sync', { chats: chatPayload, count: chatPayload.length });

        return { success: true, count: chatPayload.length };
    } catch (err) {
        console.error('[Sync] Failed to fetch or sync chats:', err.message);
        return { success: false, error: err.message };
    }
};

// GET /sync-chats - Manually trigger a chat sync from CRM
app.get('/sync-chats', authenticate, async (req, res) => {
    const result = await syncChatsToWebhook();
    if (result.success) {
        res.json({ success: true, message: `Synced ${result.count} chats to CRM.`, count: result.count });
    } else {
        res.status(503).json({ success: false, error: result.error || 'Sync failed.' });
    }
});


// --- NEW LIVE DATA ENDPOINTS ---

app.get(['/get-chats', '/api/chats'], authenticate, async (req, res) => {
    if (connectionStatus !== 'CONNECTED' || !client) return res.status(503).json({ success: false, error: 'Not connected.' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    try {
        const allChats = await client.getChats();
        const filtered = allChats.filter(c => c.id._serialized !== 'status@broadcast').slice(0, limit);
        const chats = filtered.map(chat => {
            const lastMsg = chat.lastMessage;
            return {
                chat_id: chat.id._serialized,
                name: chat.name || chat.id.user || chat.id._serialized,
                phone: chat.isGroup ? null : chat.id.user,
                is_group: chat.isGroup ? 1 : 0,
                unread_count: chat.unreadCount || 0,
                is_pinned: chat.pinned ? 1 : 0,
                is_archived: chat.archived ? 1 : 0,
                timestamp: chat.timestamp || 0,
                last_message: lastMsg ? (lastMsg.body || '') : '',
                last_message_type: lastMsg ? (lastMsg.type || 'chat') : '',
                last_message_from_me: lastMsg ? (lastMsg.fromMe ? 1 : 0) : 0,
                last_message_ts: lastMsg ? lastMsg.timestamp : 0,
                participants_count: (chat.isGroup && chat.participants) ? chat.participants.length : 0
            };
        });
        res.json({ success: true, chats, count: chats.length });
    } catch (err) {
        console.error('[get-chats] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get(['/get-messages', '/api/messages'], authenticate, async (req, res) => {
    if (connectionStatus !== 'CONNECTED' || !client) return res.status(503).json({ success: false, error: 'Not connected.' });
    const { chatId, before } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    if (!chatId) return res.status(400).json({ success: false, error: 'chatId is required.' });
    try {
        console.log('[get-messages] Fetching messages for chat:', chatId);
        const chat = await client.getChatById(chatId);
        const fetchOptions = { limit };
        if (before) fetchOptions.before = before;
        const messages = await chat.fetchMessages(fetchOptions);
        const formatted = messages.map(msg => ({
            id: msg.id._serialized,
            body: msg.body || '',
            type: msg.type || 'chat',
            from: msg.from,
            to: msg.to,
            from_me: msg.fromMe ? 1 : 0,
            timestamp: msg.timestamp,
            has_media: msg.hasMedia ? 1 : 0,
            media_mime: (msg.hasMedia && msg._data) ? (msg._data.mimetype || '') : '',
            media_filename: (msg.hasMedia && msg._data) ? (msg._data.filename || '') : '',
            author: msg.author || null,
            is_forwarded: msg.isForwarded ? 1 : 0,
            quoted_body: (msg.hasQuotedMsg && msg._data && msg._data.quotedMsg) ? msg._data.quotedMsg.body : null,
            ack: msg.ack || 0,
            notify_name: msg._data ? (msg._data.notifyName || '') : '',
            duration: msg._data ? (msg._data.duration || null) : null
        }));
        res.json({ success: true, messages: formatted, chat_id: chatId });
    } catch (err) {
        console.error('[get-messages] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/get-media', authenticate, async (req, res) => {
    if (connectionStatus !== 'CONNECTED' || !client) return res.status(503).json({ success: false, error: 'Not connected.' });
    const { msgId, chatId } = req.query;
    if (!msgId || !chatId) return res.status(400).json({ success: false, error: 'msgId and chatId required.' });
    try {
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 100 });
        const target = messages.find(m => m.id._serialized === msgId);
        if (!target) return res.status(404).json({ success: false, error: 'Message not found.' });
        if (!target.hasMedia) return res.status(400).json({ success: false, error: 'No media.' });
        const media = await target.downloadMedia();
        res.json({ success: true, mimetype: media.mimetype, data: media.data, filename: media.filename || 'attachment' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get(['/get-contact-pic', '/api/contact-pic'], authenticate, async (req, res) => {
    if (connectionStatus !== 'CONNECTED' || !client) return res.status(503).json({ success: false, error: 'Not connected.' });
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required.' });
    try {
        const jid = phone.includes('@') ? phone : (phone + '@c.us');
        const picUrl = await client.getProfilePicUrl(jid);
        res.json({ success: true, url: picUrl || null });
    } catch (err) {
        res.json({ success: true, url: null });
    }
});

app.get('/get-chat-info', authenticate, async (req, res) => {
    if (connectionStatus !== 'CONNECTED' || !client) return res.status(503).json({ success: false, error: 'Not connected.' });
    const { chatId } = req.query;
    if (!chatId) return res.status(400).json({ success: false, error: 'chatId required.' });
    try {
        const chat = await client.getChatById(chatId);
        let profilePic = null;
        try { profilePic = await client.getProfilePicUrl(chatId); } catch (e) {}
        const info = {
            chat_id: chat.id._serialized, name: chat.name || chat.id.user,
            is_group: chat.isGroup, is_pinned: chat.pinned, is_archived: chat.archived,
            profile_pic: profilePic, timestamp: chat.timestamp, unread_count: chat.unreadCount
        };
        if (chat.isGroup && chat.participants) {
            info.participants = chat.participants.map(p => ({ id: p.id._serialized, phone: p.id.user, is_admin: p.isAdmin }));
        }
        res.json({ success: true, info });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/contacts', authenticate, async (req, res) => {
    if (connectionStatus !== 'CONNECTED' || !client) return res.status(503).json({ success: false, error: 'Not connected.' });
    try {
        const contacts = await client.getContacts();
        const formatted = contacts.map(c => ({
            id: c.id._serialized,
            number: c.number,
            name: c.name,
            pushname: c.pushname,
            isGroup: c.isGroup,
            isMyContact: c.isMyContact
        }));
        res.json({ success: true, contacts: formatted, count: formatted.length });
    } catch (err) {
        console.error('[/api/contacts] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start Server
app.listen(PORT, HOST, () => {
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(`[Server] Gateway ready`);
});

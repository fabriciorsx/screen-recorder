import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { createWorker } from './mediasoup/worker.js';
import { setupSocketHandlers } from './socket/socket.handler.js';
import { log, logError } from './utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*' }
});

async function startServer() {
    try {
        await createWorker();
        setupSocketHandlers(io);

        const port = process.env.PORT || 3000;
        httpServer.listen(port, () => {
            log(`Servidor rodando na porta ${port}`);
        });
    } catch (error) {
        logError('Falha ao iniciar servidor', error);
        process.exit(1);
    }
}

startServer();

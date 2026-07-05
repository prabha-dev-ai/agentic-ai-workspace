import { Router } from 'express';
import { handleChat } from '../controllers/chat.controller.ts';

// Paths here are relative to the mount point chosen in app.ts ("/chat"),
// so this file only maps HTTP verbs to controllers.
const chatRouter = Router();

chatRouter.post('/', handleChat);

export { chatRouter };

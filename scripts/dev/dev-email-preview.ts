import http from 'http';
import path from 'path';

import chokidar from 'chokidar';
import express from 'express';
import { Server as WebSocketServer, WebSocket } from 'ws';

import EmailLib, { getTemplateAttributes } from '../../server/lib/email';
import templates, { isValidTemplate, recompileAllTemplates } from '../../server/lib/emailTemplates';
import { stripHTML } from '../../server/lib/sanitize-html';
import MOCKS from '../../test/mocks/data';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const port = 2999;
const templatesDir = path.join(__dirname, '../..', 'templates', 'emails');

const mockData = {
  host: MOCKS.host1,
  collective: MOCKS.collective1,
  fromCollective: MOCKS.collective2,
  user: MOCKS.user1,
  order: MOCKS.order1,
  remoteUser: MOCKS.user1,
  recipient: MOCKS.user2,
  event: MOCKS.event1,
  expense: MOCKS.expense1,
  items: MOCKS.expense1.items,
  email: 'test@opencollective.com',
};

// WebSocket connection handler
wss.on('connection', ws => {
  console.log('Client connected');
  ws.on('close', () => console.log('Client disconnected'));
});

// File watcher
const watcher = chokidar.watch(templatesDir, {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
});

watcher.on('change', path => {
  console.log(`File ${path} has been changed`);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      recompileAllTemplates();
      client.send('reload');
    }
  });
});

app.get('/', async (req, res) => {
  try {
    const templateList = Object.keys(templates).sort();

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Email Templates</title>
        <script>
          const socket = new WebSocket('ws://localhost:${port}');
          socket.onmessage = (event) => {
            if (event.data === 'reload') {
              location.reload();
            }
          };
        </script>
      </head>
      <body>
        <h1>Email Templates</h1>
        <ul>
          ${templateList
            .map(
              template => `
            <li><a href="/preview/${template}">${template}</a></li>
          `,
            )
            .join('')}
        </ul>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error reading templates directory');
  }
});

const renderEmail = (templateName: string) => {
  try {
    return EmailLib.generateEmailFromTemplate(templateName, mockData.email, mockData);
  } catch (error) {
    return error.toString();
  }
};

app.get('/preview/:template', async (req, res) => {
  const rawTemplateName = req.params.template;
  const safeTemplateName = stripHTML(rawTemplateName);
  if (!isValidTemplate(safeTemplateName)) {
    res.status(404).send(`
      <!DOCTYPE html>
        <html>
        <head>
          <title>Error</title>
        </head>
        <body>
          <a href="/">&#x2190; Back to templates</a>
          <h1>Error while rendering template</h1>
          <p>Template not found: <code>${safeTemplateName}</code></p>
        </body>
      </html>
    `);
    return;
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Preview: ${safeTemplateName}</title>
      <script>
        const socket = new WebSocket('ws://localhost:${port}');
        socket.onmessage = (event) => {
          if (event.data === 'reload') {
            location.reload();
          }
        };
      </script>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        h1 { margin-bottom: 20px; }
        .subject-container {
          display: flex;
          align-items: center;
          margin-bottom: 20px;
          border: 1px solid #ddd;
          padding: 10px;
        }
        .subject-container span { margin-right: 10px; }
        .subject-container iframe { flex: 1; border: none; height: 34px; }
        .content-preview { 
          border: 1px solid #ddd;
          width: 100%;
          min-height: 800px;
        }
        .text-preview {
          overflow: auto;
          max-width: 100%;
          background-color: #f8f9fa;
          padding: 10px;
        }
      </style>
    </head>
    <body>
      <a href="/">&#x2190; Back to templates</a>
      <h1>Rendering template: <code>${safeTemplateName}</code></h1>
      <div class="subject-container">
        <span>Subject:</span>
        <iframe src="/render/${safeTemplateName}/title"></iframe>
      </div>
      <iframe class="content-preview" src="/render/${safeTemplateName}"></iframe>
      <h2>Text version</h2>
      <pre class="text-preview">${renderEmail(safeTemplateName).text}</pre>
    </body>
    </html>
  `);
});

app.get('/render/:template', async (req, res) => {
  const templateName = req.params.template;
  try {
    if (!isValidTemplate(templateName)) {
      throw new Error(`Template not found: ${templateName}`);
    }

    const renderResult = renderEmail(templateName);
    const attributes = getTemplateAttributes(renderResult.html);
    res.send(attributes.body);
  } catch (error) {
    res.status(400).send(`
      <!DOCTYPE html>
        <html>
        <head>
          <title>Error</title>
        </head>
        <body>
          <a href="/">&#x2190; Back to templates</a>
          <h1>Error while rendering template</h1>
          <p>${stripHTML(error.message)}. Details:</p>
          <pre style="background-color: #f8f9fa; padding: 10px; overflow: auto; max-width: 100%;">${stripHTML(error.stack)}</pre>
        </body>
      </html>
    `);
  }
});
app.get('/render/:template/title', async (req, res) => {
  const templateName = req.params.template;
  try {
    const renderResult = renderEmail(templateName);
    const attributes = getTemplateAttributes(renderResult.html);
    res.send(attributes.subject);
  } catch (error) {
    console.error(error);
    res.status(400).send(`Error while generating title`);
  }
});

server.listen(port, () => {
  console.log(`Email preview server running at http://localhost:${port}`);
});

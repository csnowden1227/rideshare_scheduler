import express from 'express';

const app = express();
app.use(express.json());

app.post('/webhooks/ghl/lead', (req, res) => {
    console.log('Received webhook:', req.body);
    res.status(200).json({ message: 'Webhook received!' });
});

const PORT = 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

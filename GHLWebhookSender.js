// GHLWebhookSender.js
import axios from 'axios';

export const sendToGHL = async (data) => {
  const CRM_WEBHOOK_URL = 'YOUR_CRM_WEBHOOK_URL_HERE';

  try {
    const response = await axios.post(WEBHOOK_URL, data);
    console.log('Successfully sent to GHL:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending to GHL:', error.message);
    throw error;
  }
};
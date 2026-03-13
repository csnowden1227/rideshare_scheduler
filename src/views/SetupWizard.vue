<script setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';

const route = useRoute();
const crmId = ref(null);
const crm_webhook_url = ref(''); // We'll store the URL here

onMounted(() => {
  crmId.value = route.query.id;
});

const saveSettings = async () => {
  try {
    const response = await axios.post('http://localhost:8080/api/save-config', {
      id: crmId.value,
      crm_webhook_url: crm_webhook_url.value, // Sending the custom URL
      status: 'active'
    });
    
    alert('Webhook URL saved successfully!');
  } catch (error) {
    console.error('Save failed:', error);
  }
};
</script>

<template>
  <div class="setup-container">
    <h1>🚀 Rideshare Setup</h1>
    
    <div v-if="crmId">
      <p>Configuring for: <code>{{ crmId }}</code></p>
      
      <div class="input-group">
        <label>Enter your GHL Webhook URL:</label>
        <input 
          v-model="crm_webhook_url" 
          placeholder="https://services.leadconnectorhq.com/hooks/..."
        />
      </div>

      <button @click="saveSettings" class="save-btn">Save Configuration</button>
    </div>
  </div>
</template>

<style scoped>
.input-group { margin: 20px 0; text-align: left; }
input { width: 100%; padding: 10px; border-radius: 5px; border: 1px solid #ccc; margin-top: 5px; }
/* ... existing styles ... */
</style>

<style scoped>
.setup-container {
  max-width: 600px;
  margin: 40px auto;
  padding: 20px;
  font-family: 'Inter', sans-serif;
  text-align: center;
  border: 1px solid #eee;
  border-radius: 12px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.badge-success {
  background-color: #e6fffa;
  border: 1px solid #38b2ac;
  color: #2c7a7b;
  padding: 15px;
  border-radius: 8px;
  margin: 20px 0;
}

.badge-error {
  background-color: #fff5f5;
  border: 1px solid #f56565;
  color: #c53030;
  padding: 15px;
  border-radius: 8px;
  margin: 20px 0;
}

code {
  background: #2d3748;
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
}

.save-btn {
  background-color: #4a90e2;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: bold;
}

.save-btn:hover {
  background-color: #357abd;
}
</style>
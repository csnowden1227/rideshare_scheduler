<template>
  <div class="home-container">
    <div class="hero">
      <h1>SaaS Master Engine</h1>
      <p>Intelligent Booking & Dispatch System</p>
    </div>

    <div class="dashboard-grid">
      <div class="card shadow">
        <h3>System Configuration</h3>
        <p>To initialize the engine, please launch the Setup Wizard.</p>
        <router-link to="/setup-wizard?id=crm_test_001" class="btn-link">
          Go to Setup Wizard →
        </router-link>
      </div>

      <div class="card shadow">
        <h3>Engine Status</h3>
        <div class="status-indicator">
          <span class="dot"></span> 
          <span>Connected to Node.js Backend</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-container { padding: 40px; font-family: 'Inter', sans-serif; color: #2d3748; }
.hero { text-align: center; margin-bottom: 50px; }
.hero h1 { font-size: 2.5rem; color: #2b6cb0; }
.dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 25px; max-width: 1000px; margin: 0 auto; }
.card { background: white; padding: 25px; border-radius: 12px; border: 1px solid #e2e8f0; }
.shadow { box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
.btn-link { display: inline-block; margin-top: 15px; padding: 10px 20px; background: #4a90e2; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; }
.status-indicator { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-weight: 500; }
.dot { height: 12px; width: 12px; background-color: #48bb78; border-radius: 50%; display: inline-block; }
</style>
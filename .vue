<template>
  <div>
    <h1>Setup Wizard</h1>
    <p v-if="!locationId">Error: No Location ID detected from GoHighLevel.</p>
    <p v-else>Loading settings for Location: {{ locationId }}</p>
  </div>
</template>

<script>
// 1. Imports go at the very top
import { useRoute } from 'vue-router';
import { onMounted, ref } from 'vue';

export default {
  name: 'SetupWizard',
  setup() {
    // 2. Initialize the router tools
    const route = useRoute();
    const locationId = ref(null);

    // 3. This runs as soon as the component is put on the screen
    onMounted(() => {
      // This grabs the ID from: ?location_id=XYZ
      const idFromUrl = route.query.location_id; 

      if (idFromUrl) {
        locationId.value = idFromUrl;
        console.log("Success! Found Location ID:", idFromUrl);
        
        // This is where you trigger your data loading
        // Example: store.dispatch('fetchSettings', idFromUrl);
      } else {
        console.error("No Location ID found! Make sure GHL link is correct.");
      }
    });

    // 4. Return variables so the <template> can see them
    return {
      locationId
    };
  }
}
</script>

<style scoped>
/* Your CSS here */
</style>
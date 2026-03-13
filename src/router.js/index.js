import { createRouter, createWebHistory } from 'vue-router';
import SetupWizard from '../views/SetupWizard.vue';

const routes = [
  {
    path: '/setup-wizard',
    name: 'SetupWizard',
    component: SetupWizard,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
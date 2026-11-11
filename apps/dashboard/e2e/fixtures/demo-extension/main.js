window.heybe.dashboard.addPage({
  path: "demo",
  title: "Demo",
  mount(el, { client }) {
    el.textContent = "Demo extension for " + client.authStore.record.email;
  },
});

<script setup>
import { ref } from "vue";
import Wrapper from "../../../shared/ui/src/components/Wrapper.vue";
const label = ref("Save");
</script>

<template>
  <main>
    <h1>Feedback sample</h1>
    <Wrapper :label="label" />
    <button @click="label = 'Updated'">
      Update label
    </button>
  </main>
</template>

<style>
body { margin: 64px; font: 18px system-ui; }
button { padding: 20px; margin: 16px; }
</style>

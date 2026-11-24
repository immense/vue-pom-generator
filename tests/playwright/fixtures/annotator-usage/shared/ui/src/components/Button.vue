<script setup>
defineProps({ label: String });
</script>

<template>
  <button data-testid="shared-button">
    <span>{{ label }}</span>
  </button>
</template>

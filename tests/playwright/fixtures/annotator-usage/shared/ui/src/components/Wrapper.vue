<script setup>
import Button from "./Button.vue";
defineProps({ label: String });
</script>

<template>
  <Button :label="label" />
</template>

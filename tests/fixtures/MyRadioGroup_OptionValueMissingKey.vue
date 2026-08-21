<template>
  <div role="radiogroup">
    <!-- eslint-disable-next-line vue/require-v-for-key -->
    <input
      v-for="option in options"
      v-model="modelValue"
      type="radio"
      name="option"
      :value="option.value"
    >
  </div>
</template>

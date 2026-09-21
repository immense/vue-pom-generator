<template>
  <div role="radiogroup">
    <input v-for="option in options" :key="option.id" v-model="modelValue" type="radio" name="option" :value="option.value">
  </div>
</template>

<template>
  <div role="radiogroup">
    <input v-for="(option, index) in options" :key="index" v-model="modelValue" type="radio" name="option" :value="option.value">
  </div>
</template>

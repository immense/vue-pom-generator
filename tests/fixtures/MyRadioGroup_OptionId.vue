<template>
  <div role="radiogroup">
    <input v-for="option in options" :key="option.id" type="radio" name="option" :value="option.value" v-model="modelValue" />
  </div>
</template>

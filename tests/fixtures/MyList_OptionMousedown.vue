<template>
  <ul role="listbox">
    <li v-for="(option, index) in options" :key="index" role="option" :data-value="option.value" @mousedown.prevent="select(option)">{{ option.label }}</li>
  </ul>
</template>

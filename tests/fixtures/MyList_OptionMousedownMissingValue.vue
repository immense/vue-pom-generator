<template>
  <ul role="listbox">
    <li v-for="(option, index) in options" :key="index" role="option" @mousedown.prevent="select(option)">
      {{ option.label }}
    </li>
  </ul>
</template>

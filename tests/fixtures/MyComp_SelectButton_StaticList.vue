<template>
  <button v-for="item in ['One','Two']" :key="item" @click="select(item)">
    Select
  </button>
</template>

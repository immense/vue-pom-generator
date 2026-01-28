<template>
  <button v-for="item in items" :key="item.id" @click="select(item)">
    Select
  </button>
</template>

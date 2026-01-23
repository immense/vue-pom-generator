<template>
  <button v-for="n in [Math.random(), Math.random(), Math.random()]" :key="n" @click="doThing(n)">Go</button>
</template>

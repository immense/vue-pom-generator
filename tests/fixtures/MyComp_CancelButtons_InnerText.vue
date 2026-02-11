<script setup lang="ts">
const shouldAbort = true
const item = { key: "abc" }
function cancel(_key: string) {
  // noop
}
</script>

<template>
  <div>
    <MyButton v-if="shouldAbort" variant="danger" @click="cancel(item.key)">
      <i class="fal fa-skull" />
      Terminate
    </MyButton>

    <MyButton v-else variant="warning" @click="cancel(item.key)">
      Request Cancellation
    </MyButton>
  </div>
</template>

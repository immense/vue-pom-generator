<template>
  <div>
    <ImmyButton v-if="shouldAbort" variant="danger" @click="cancel(item.key)">
      <i class="fal fa-skull" />
      Terminate
    </ImmyButton>

    <ImmyButton v-else variant="warning" @click="cancel(item.key)">
      Request Cancellation
    </ImmyButton>
  </div>
</template>

<script setup lang="ts">
const shouldAbort = true
const item = { key: "abc" }
function cancel(_key: string) {
  // noop
}
</script>

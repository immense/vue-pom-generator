<template>
  <div role="radiogroup">
    <template v-for="(option, index) in options" :key="index">
      <label v-if="buttons">
        <input
          type="radio"
          :name="name"
          :checked="Object.is(modelValue, option.value)"
          @change="modelValue = option.value"
        >
        {{ option.text }}
      </label>
    </template>
  </div>
</template>

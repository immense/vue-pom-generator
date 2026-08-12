<template>
  <div role="radiogroup">
    <template v-for="(option, index) in options" :key="index">
      <label v-if="buttons">
        <input
          type="radio"
          :value="option.value"
          :name="name"
          :checked="Object.is(modelValue, option.value)"
          @change="modelValue = option.value"
        />
        {{ option.text }}
      </label>
      <div v-else>
        <input
          type="radio"
          :value="option.value"
          :name="name"
          :checked="Object.is(modelValue, option.value)"
          @change="modelValue = option.value"
        />
        <label>{{ option.text }}</label>
      </div>
    </template>
  </div>
</template>

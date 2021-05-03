module.exports = {
  preset: 'ts-jest',
  globals: {
    'ts-jest': {
      tsconfig: "./tsconfig.eslint.json",
    },
  },
  testEnvironment: 'node',
};

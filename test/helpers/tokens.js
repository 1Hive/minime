const { bigExp, bn } = require('@1hive/contract-helpers-test')

function tokenAmount(amount) {
  return bigExp(amount, 18)
}

module.exports = {
  tokenAmount,
}
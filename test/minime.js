const { ethers } = require('hardhat')
const {
  bn,
  MAX_UINT256,
  ZERO_ADDRESS,
} = require("@1hive/contract-helpers-test");
const { assertBn, assertEvent, assertRevert } = require('@1hive/contract-helpers-test/src/asserts')
const web3Accounts = require("web3-eth-accounts");
const { ecsign, ecrecover } = require("ethereumjs-util");
const utils = require("web3-utils");
const { keccak256 } = require("web3-utils");

const { createPermitDigest, PERMIT_TYPEHASH } = require('./helpers/erc2612')
const { tokenAmount } = require('./helpers/tokens')
const { createTransferWithAuthorizationDigest, TRANSFER_WITH_AUTHORIZATION_TYPEHASH } = require('./helpers/erc3009')

const MiniMeToken = artifacts.require("MiniMeToken");
const MiniMeTokenFactory = artifacts.require("MiniMeTokenFactory");

const getBlockNumber = async () => ethers.provider.getBlockNumber()

contract('MiniMeToken', accounts => {
    let factory = {}
    let token = {}
    let clone1 = {}

    it('should deploy contracts', async () => {
        factory = await MiniMeTokenFactory.new()
        token = await MiniMeToken.new(
            factory.address,
            0,
            0,
            'MiniMe Test Token',
            18,
            'MMT',
            true)

        assert.ok(token)
    })

    context('create, destroy, and claim tokens', () => {
        it('reverts when overflowing the token supply', async () => {
            const maxUint128 = web3.toBigNumber(2).pow(128).minus(1)
            const mintAmount = maxUint128.add(1) // Larger than max uint128

            await assertRevert(token.generateTokens(accounts[1], mintAmount))
        })

        it('should generate tokens', async () => {
            await token.generateTokens(accounts[1], 100)
            assert.equal(await token.totalSupply(), 100, 'total supply generated should be 100')
            assert.equal(await token.balanceOf(accounts[1]), 100, 'accounts[1] balance should be 100')
        })

        it('should be able to destroy tokens', async () => {
            await token.destroyTokens(accounts[1], 20)

            let block = await getBlockNumber()

            assert.equal(await token.totalSupply(), 80, 'total supply should be at 80')
            assert.equal(await token.totalSupplyAt(block - 1), 100, 'total supply should be 100 in previous block')
            assert.equal(await token.balanceOf(accounts[1]), 80, 'should have destroyed 20 tokens from orignal amount')

            await assertRevert(token.destroyTokens(accounts[2], 100))
        })
    })

    context('test multi-transfer and disabling', () => {
        it('token should be able to transfer from account 1 to account 2', async () => {
            await token.transferFrom(accounts[1], accounts[2], 10)

            let block = await getBlockNumber()

            assert.equal(await token.totalSupply(), 80, 'total supply should still be at 80')
            assert.equal(await token.balanceOf(accounts[1]), 70, 'accounts[1] should have updated balance of 60')
            assert.equal(await token.balanceOf(accounts[2]), 10, 'accounts[2] should have a balance of 10')
            assert.equal(await token.balanceOfAt(accounts[1], block - 1), 80, 'accounts[1] balance should be 80 in previous block')
        })

        it('token should be able to transfer from account 2 to account 3', async () => {
            await token.transferFrom(accounts[2], accounts[3], 5)

            let block = await getBlockNumber()

            assert.equal(await token.totalSupply(), 80, 'total supply should still be at 80')
            assert.equal(await token.balanceOf(accounts[2]), 5, 'accounts[2] should have updated balance of 5')
            assert.equal(await token.balanceOf(accounts[3]), 5, 'accounts[3] should have a balance of 5')
            assert.equal(await token.balanceOfAt(accounts[2], block - 1), 10, 'accounts[2] balance should be 10 in previous block')
        })

        it('check transfer from controller', async () => {
            await token.transfer(accounts[2], 5)
            assert.equal(await token.balanceOf(accounts[2]), 5, 'accounts[2] should now have 10 tokens')

            assert.ok(await token.transfer(accounts[1], 0))
        })

        it('claim tokens', async () => {
            assert.ok(await token.claimTokens(0x0))
            assert.ok(await token.claimTokens(token.address))
            await assertRevert(token.transfer(token.address, 5))
        })

        it('disable transfers', async () => {
            await token.enableTransfers(false)
            await assertRevert(token.transfer(accounts[3], 5))
        })

        it('re-enable transfers', async () => {
            await token.enableTransfers(true)
        })

        it('approve tokens for spending', async () => {
            assert.ok(await token.approve(accounts[3], 10))
            assert.equal(await token.allowance(accounts[0], accounts[3]), 10, 'account 3 should have an allowance')
            await token.transferFrom(accounts[0], accounts[4], 5, { from: accounts[3] })

            const newAllowance = await token.allowance(accounts[0], accounts[3])
            assert.equal(newAllowance, 5, 'should have an allowance of 5')
        })

        it('refuse new allowances if transfer are disabled', async () => {
            await token.enableTransfers(false)
            await assertRevert(token.approve(accounts[2], 10))
        })
    })

    context('test all cloning', () => {
        it('should be able to clone token', async () => {
            // We create a clone token out of a past block
            const cloneTokenTx = await token.createCloneToken('MMT2', 18, 'MMT2', 0, false)
            const addr = cloneTokenTx.logs[0].args._cloneToken

            clone1 = MiniMeToken.at(addr)
        })

        it('has the same total supply than parent token', async () => {
            assert.equal((await token.totalSupply()).toNumber(), (await clone1.totalSupply()).toNumber(), 'tokens should have the same total supply')
        })

        it('keep main balances from parent token', async () => {
            assert.isAbove((await token.balanceOf(accounts[1])).toNumber(), 0, 'account 1 should own some tokens')

            assert.equal((await token.balanceOf(accounts[1])).toNumber(), (await clone1.balanceOf(accounts[1])).toNumber(), 'account balances should be the same')
        })

        it('should not have kept allowances from parent token', async () => {
            let tokenAllowance = await token.allowance(accounts[0], accounts[3])
            let cloneAllowance = await clone1.allowance(accounts[0], accounts[3])

            assert.equal(tokenAllowance, 5, 'should have an allowance of 5 for main token')
            assert.equal(cloneAllowance, 0, 'should have no allowance for clone token')
        })

        it('generate some clone tokens to account 4', async () => {
            await clone1.generateTokens(accounts[4], 1000)

            let block = await getBlockNumber()

            assert.equal(await clone1.balanceOfAt(accounts[4], block), 1000, 'should have balance of 1000')
            assert.equal(await clone1.balanceOfAt(accounts[4], block - 1), 0, 'should have previous balance of 0')
        })

        it('cloned token transfers from account 4 to account 5', async () => {
            await clone1.transferFrom(accounts[4], accounts[5], 100)

            let block = await getBlockNumber()

            assert.equal(await clone1.balanceOf(accounts[4]), 900, 'should only have 900 tokens after transfer')
            assert.equal(await clone1.balanceOfAt(accounts[4], block - 1), 1000, 'should have 1000 in the past block')
            assert.equal(await clone1.balanceOf(accounts[5]), 100, 'transferee should have balance of 100')
            assert.equal(await clone1.balanceOfAt(accounts[5], block - 1), 0, 'transferee should have previous balance of 0')
        })
    })

    context('ERC-2612', () => {

        let _owner, ownerPrivKey
        const _spender = accounts[3]
        let wallet;

        async function createPermitSignature(_owner, _spender, value, nonce, deadline) {
            const digest = await createPermitDigest(token, _owner, _spender, value, nonce, deadline)

            const { r, s, v } = ecsign(
                Buffer.from(digest.slice(2), 'hex'),
                Buffer.from(ownerPrivKey.slice(2), 'hex')
            )

            return { r, s, v }
        }

        before(async () => {
            var accountsWeb3 = new web3Accounts('http://localhost:8545');
            wallet = accountsWeb3.create('erc2612')
            _owner = wallet.address
            ownerPrivKey = wallet.privateKey
        })

        beforeEach(async () => {
            await token.transferFrom(accounts[1], _owner, 10)
            await token.enableTransfers(true)
        })

        it('has the correct permit typehash', async () => {
            assert.equal(await token.PERMIT_TYPEHASH(), PERMIT_TYPEHASH, 'erc2612: typehash')
        })

        it('can set allowance through permit', async () => {
            const deadline = MAX_UINT256

            const firstValue = tokenAmount(3)
            const firstNonce = await token.nonces(_owner)
            const firstSig = await createPermitSignature(_owner, _spender, firstValue, firstNonce, deadline)

            const firstReceipt = await token.permit(_owner, _spender, utils.toHex(firstValue), utils.toHex(deadline), utils.toHex(firstSig.v), utils.toHex(firstSig.r), utils.toHex(firstSig.s))

            assertBn(await token.allowance(_owner, _spender), firstValue, 'erc2612: first permit allowance')
            assertBn(await token.nonces(_owner), firstNonce.add(bn(1)), 'erc2612: first permit nonce')
            assertEvent(firstReceipt, 'Approval', { expectedArgs: { _owner, _spender, _amount: firstValue } })

            const secondValue = tokenAmount(0)
            const secondNonce = await token.nonces(_owner)
            const secondSig = await createPermitSignature(_owner, _spender, secondValue, secondNonce, deadline)
            const secondReceipt = await token.permit(_owner, _spender, utils.toHex(secondValue), utils.toHex(deadline), utils.toHex(secondSig.v), utils.toHex(secondSig.r), utils.toHex(secondSig.s))

            assertBn(await token.allowance(_owner, _spender), secondValue, 'erc2612: second permit allowance')
            assertBn(await token.nonces(_owner), secondNonce.add(bn(1)), 'erc2612: second permit nonce')
            assertEvent(secondReceipt, 'Approval', { expectedArgs: { _owner, _spender, _amount: secondValue } })


            const thirdValue = tokenAmount(5)
            const thirdNonce = await token.nonces(_owner)
            const thirdSig = await createPermitSignature(_owner, _spender, thirdValue, thirdNonce, deadline)
            const thirdReceipt = await token.permit(_owner, _spender, utils.toHex(thirdValue), utils.toHex(deadline), utils.toHex(thirdSig.v), utils.toHex(thirdSig.r), utils.toHex(thirdSig.s))

            assertBn(await token.allowance(_owner, _spender), thirdValue, 'erc2612: second permit allowance')
            assertBn(await token.nonces(_owner), thirdNonce.add(bn(1)), 'erc2612: second permit nonce')
            assertEvent(thirdReceipt, 'Approval', { expectedArgs: { _owner, _spender, _amount: thirdValue } })
        })

        it('cannot use wrong signature', async () => {
            const deadline = MAX_UINT256
            const nonce = await token.nonces(_owner)

            const firstValue = tokenAmount(100)
            const secondValue = tokenAmount(500)
            const firstSig = await createPermitSignature(_owner, _spender, firstValue, nonce, deadline)
            const secondSig = await createPermitSignature(_owner, _spender, secondValue, nonce, deadline)

            // Use a mismatching signature
            await assertRevert(token.permit(_owner, _spender, utils.toHex(firstValue), utils.toHex(deadline), utils.toHex(secondSig.v), utils.toHex(secondSig.r), utils.toHex(secondSig.s)), '_validateSignedData: INVALID_SIGNATURE')
        })
        it('cannot use expired permit', async () => {
            const value = tokenAmount(100)
            const nonce = await token.nonces(_owner)

            const deadline = bn(Math.floor(Date.now() / 1000) - 60)

            const { r, s, v } = await createPermitSignature(_owner, _spender, value, nonce, deadline)
            await assertRevert(token.permit(_owner, _spender, utils.toHex(value), utils.toHex(deadline), utils.toHex(v), utils.toHex(r), utils.toHex(s)), 'permit: AUTH_EXPIRED')
        })

        it('cannot use surpassed permit', async () => {
            const deadline = MAX_UINT256
            const nonce = await token.nonces(_owner)

            // Generate two signatures with the same nonce and use one
            const firstValue = tokenAmount(100)
            const secondValue = tokenAmount(0)
            const firstSig = await createPermitSignature(_owner, _spender, firstValue, nonce, deadline)
            const zeroSig = await createPermitSignature(_owner, _spender, 0, nonce, deadline)
            const secondSig = await createPermitSignature(_owner, _spender, secondValue, nonce, deadline)

            // Using one should disallow the other
            await token.permit(_owner, _spender, utils.toHex(secondValue), utils.toHex(deadline), utils.toHex(secondSig.v), utils.toHex(secondSig.r), utils.toHex(secondSig.s))
            await assertRevert(token.permit(_owner, _spender, utils.toHex(firstValue), utils.toHex(deadline), utils.toHex(firstSig.v), utils.toHex(firstSig.r), utils.toHex(firstSig.s)), '_validateSignedData: INVALID_SIGNATURE')
        })
    })
    context('ERC-3009', () => {

        let from, fromPrivKey
        const to = accounts[4]

        async function createTransferWithAuthorizationSignature(from, to, value, validBefore, validAfter, nonce) {
            const digest = await createTransferWithAuthorizationDigest(token, from, to, value, validBefore, validAfter, nonce)

            const { r, s, v } = ecsign(
                Buffer.from(digest.slice(2), 'hex'),
                Buffer.from(fromPrivKey.slice(2), 'hex')
            )

            return { r, s, v }
        }

        async function itTransfersCorrectly(fn, { from, to, value }) {
            const isMint = from === ZERO_ADDRESS
            const isBurn = to === ZERO_ADDRESS

            const prevFromBal = await token.balanceOf(from)
            const prevToBal = await token.balanceOf(to)
            const prevSupply = await token.totalSupply()

            const receipt = await fn(from, to, value)

            if (isMint) {
                assertBn(await token.balanceOf(to), prevToBal.add(value), 'mint: to balance')
                assertBn(await token.totalSupply(), prevSupply.add(value), 'mint: total supply')
            } else if (isBurn) {
                assertBn(await token.balanceOf(from), prevFromBal.sub(value), 'burn: from balance')
                assertBn(await token.totalSupply(), prevSupply.sub(value), 'burn: total supply')
            } else {
                assertBn(await token.balanceOf(from), prevFromBal.sub(value), 'transfer: from balance')
                assertBn(await token.balanceOf(to), prevToBal.add(value), 'transfer: to balance')
                assertBn(await token.totalSupply(), prevSupply, 'transfer: total supply')
            }

            assertEvent(receipt, 'Transfer', { expectedArgs: { _from: from, _to: to, _amount: bn(value) } })
        }

        before(async () => {
            var accountsWeb3 = new web3Accounts('http://localhost:8545');
            wallet = accountsWeb3.create('erc3009')
            from = wallet.address
            fromPrivKey = wallet.privateKey
        })

        beforeEach(async () => {
            await token.generateTokens(from, utils.toHex(tokenAmount(100)))
            await token.enableTransfers(true)
        })

        it('has the correct transferWithAuthorization typehash', async () => {
            assert.equal(await token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), TRANSFER_WITH_AUTHORIZATION_TYPEHASH, 'erc3009: typehash')
        })

        it('can transfer through transferWithAuthorization', async () => {
            const validAfter = 0
            const validBefore = MAX_UINT256

            const firstNonce = keccak256('first')
            const secondNonce = keccak256('second')
            assert.equal(await token.authorizationState(from, firstNonce), false, 'erc3009: first auth unused')
            assert.equal(await token.authorizationState(from, secondNonce), false, 'erc3009: second auth unused')

            const firstValue = tokenAmount(25)
            const firstSig = await createTransferWithAuthorizationSignature(from, to, firstValue, validAfter, validBefore, firstNonce)
            await itTransfersCorrectly(
                () => token.transferWithAuthorization(from, to, utils.toHex(firstValue), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(firstNonce), utils.toHex(firstSig.v), utils.toHex(firstSig.r), utils.toHex(firstSig.s)),
                { from, to, value: utils.toHex(firstValue) }
            )
            assert.equal(await token.authorizationState(from, firstNonce), true, 'erc3009: first auth')

            const secondValue = tokenAmount(10)
            const secondSig = await createTransferWithAuthorizationSignature(from, to, secondValue, validAfter, validBefore, secondNonce)
            await itTransfersCorrectly(
                () => token.transferWithAuthorization(from, to, utils.toHex(secondValue), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(secondNonce), utils.toHex(secondSig.v), utils.toHex(secondSig.r), utils.toHex(secondSig.s)),
                { from, to, value: utils.toHex(secondValue) }
            )
            assert.equal(await token.authorizationState(from, secondNonce), true, 'erc3009: second auth')

        })

        it('cannot transfer above balance', async () => {
            const value = (await token.balanceOf(from)).add(bn('1'))
            const nonce = keccak256('nonce')
            const validAfter = 0
            const validBefore = MAX_UINT256

            const { r, s, v } = await createTransferWithAuthorizationSignature(from, to, value, validAfter, validBefore, nonce)
            await assertRevert(
                token.transferWithAuthorization(from, to, utils.toHex(value), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(v), utils.toHex(r), utils.toHex(s))
            )
        })

        it('cannot transfer to token', async () => {
            const value = tokenAmount(100)
            const nonce = keccak256('nonce')
            const validAfter = 0
            const validBefore = MAX_UINT256

            const { r, s, v } = await createTransferWithAuthorizationSignature(from, token.address, value, validAfter, validBefore, nonce)
            await assertRevert(
                token.transferWithAuthorization(from, token.address, utils.toHex(value), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(v), utils.toHex(r), utils.toHex(s))
            )
        })

        it('cannot transfer to zero address', async () => {
            const value = tokenAmount(100)
            const nonce = keccak256('nonce')
            const validAfter = 0
            const validBefore = MAX_UINT256

            const { r, s, v } = await createTransferWithAuthorizationSignature(from, ZERO_ADDRESS, value, validAfter, validBefore, nonce)
            await assertRevert(
                token.transferWithAuthorization(from, ZERO_ADDRESS, utils.toHex(value), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(v), utils.toHex(r), utils.toHex(s))
            )
        })

        it('cannot use wrong signature', async () => {
            const validAfter = 0
            const validBefore = MAX_UINT256

            const firstNonce = keccak256('first')
            const firstValue = tokenAmount(25)
            const firstSig = await createTransferWithAuthorizationSignature(from, to, firstValue, validAfter, validBefore, firstNonce)

            const secondNonce = keccak256('second')
            const secondValue = tokenAmount(10)
            const secondSig = await createTransferWithAuthorizationSignature(from, to, secondValue, validAfter, validBefore, secondNonce)

            // Use a mismatching signature
            await assertRevert(
                token.transferWithAuthorization(from, to, utils.toHex(firstValue), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(firstNonce), utils.toHex(secondSig.v), utils.toHex(secondSig.r), utils.toHex(secondSig.s))
            )
        })

        it('cannot use before valid period', async () => {
            const value = tokenAmount(100)
            const nonce = keccak256('nonce')

            // Use a future period
            const validAfter = bn(Math.floor(Date.now() / 1000) + 60)
            const validBefore = MAX_UINT256

            const { r, s, v } = await createTransferWithAuthorizationSignature(from, to, value, validAfter, validBefore, nonce)
            await assertRevert(
                token.transferWithAuthorization(from, to, utils.toHex(value), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(v), utils.toHex(r), utils.toHex(s))
            )
        })

        it('cannot use after valid period', async () => {
            const value = tokenAmount(100)
            const nonce = keccak256('nonce')

            // Use a prior period
            const validBefore = bn(Math.floor(Date.now() / 1000) - 60)
            const validAfter = 0

            const { r, s, v } = await createTransferWithAuthorizationSignature(from, to, value, validAfter, validBefore, nonce)
            await assertRevert(
                token.transferWithAuthorization(from, to, utils.toHex(value), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(v), utils.toHex(r), utils.toHex(s))
            )
        })

        it('cannot use expired nonce', async () => {
            const nonce = keccak256('nonce')
            const validAfter = 0
            const validBefore = MAX_UINT256

            const firstValue = tokenAmount(25)
            const secondValue = tokenAmount(10)
            const firstSig = await createTransferWithAuthorizationSignature(from, to, firstValue, validAfter, validBefore, nonce)
            const secondSig = await createTransferWithAuthorizationSignature(from, to, secondValue, validAfter, validBefore, nonce)

            // Using one should disallow the other
            await token.transferWithAuthorization(from, to, utils.toHex(firstValue), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(firstSig.v), utils.toHex(firstSig.r), utils.toHex(firstSig.s))
            await assertRevert(
                token.transferWithAuthorization(from, to, utils.toHex(secondValue), utils.toHex(validAfter), utils.toHex(validBefore), utils.toHex(nonce), utils.toHex(secondSig.v), utils.toHex(secondSig.r), utils.toHex(secondSig.s)))
        })
    })
})

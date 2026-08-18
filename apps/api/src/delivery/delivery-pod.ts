import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const DELIVERY_POD_VERSION = 1;

const DELIVERY_POD_SPACE =
  10_000;

const UINT32_SPACE =
  0x1_0000_0000;

const DELIVERY_POD_ACCEPT_LIMIT =
  Math.floor(
    UINT32_SPACE / DELIVERY_POD_SPACE,
  ) * DELIVERY_POD_SPACE;

export interface DeliveryPodDerivationInput {
  tenantId: string;
  branchId: string;

  deliveryId: string;

  deliveryTrackingToken: string;
}

function getDeliveryPodSecret() {
  const secret =
    process.env.FLASH_DELIVERY_POD_SECRET?.trim();

  if (!secret) {
    throw new Error(
      'FLASH_DELIVERY_POD_SECRET is required',
    );
  }

  if (secret.length < 32) {
    throw new Error(
      'FLASH_DELIVERY_POD_SECRET must be at least 32 characters',
    );
  }

  return secret;
}

function buildDeliveryPodMaterial(
  input: DeliveryPodDerivationInput,
) {
  return JSON.stringify({
    version: DELIVERY_POD_VERSION,

    tenantId: input.tenantId,
    branchId: input.branchId,

    deliveryId: input.deliveryId,

    deliveryTrackingToken:
      input.deliveryTrackingToken,
  });
}

export function deriveDeliveryPod(
  input: DeliveryPodDerivationInput,
) {
  const digest =
    createHmac(
      'sha256',
      getDeliveryPodSecret(),
    )
      .update(
        buildDeliveryPodMaterial(input),
        'utf8',
      )
      .digest();

  // --------------------------------------------------------
  // Avoid modulo bias.
  //
  // The SHA-256 digest gives us eight unsigned 32-bit
  // candidates. We only accept values below the largest
  // multiple of 10,000 that fits in the uint32 space.
  // --------------------------------------------------------

  for (
    let offset = 0;
    offset + 4 <= digest.length;
    offset += 4
  ) {
    const candidate =
      digest.readUInt32BE(offset);

    if (
      candidate <
      DELIVERY_POD_ACCEPT_LIMIT
    ) {
      return String(
        candidate %
          DELIVERY_POD_SPACE,
      ).padStart(
        4,
        '0',
      );
    }
  }

  // With SHA-256 this path is practically unreachable,
  // but failing closed is preferable to biased fallback.
  throw new Error(
    'Unable to derive delivery POD',
  );
}
export function verifyDeliveryPod(
  input: DeliveryPodDerivationInput,
  submittedPod: string,
) {
  if (!/^[0-9]{4}$/.test(submittedPod)) {
    return false;
  }

  const expectedPod =
    deriveDeliveryPod(input);

  const expectedBuffer =
    Buffer.from(
      expectedPod,
      'utf8',
    );

  const submittedBuffer =
    Buffer.from(
      submittedPod,
      'utf8',
    );

  return (
    submittedBuffer.length ===
      expectedBuffer.length &&
    timingSafeEqual(
      submittedBuffer,
      expectedBuffer,
    )
  );
}

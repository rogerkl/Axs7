// fm1-base's web/fm1pkg.js (MPL-2.0, copied as it is): FM-1 .fwsc packages in the browser. Its types, for what Axs7
// uses of it.

/** the package identity ("FM-1_8700") */
export declare function productOf(fwsc: Uint8Array): string;
/** the image the device addresses during an update: the .fwsc without its 20 marker bytes */
export declare function logicalImage(fwsc: Uint8Array): Uint8Array;
/** throws an Error saying what is damaged; nothing when the package's checksums hold */
export declare function checkUfw(image: Uint8Array): void;
/** the parts of a logical image by type (0 flash.bin, 100 ota.bin) */
export declare function ufwEntries(image: Uint8Array): Record<number, { off: number; len: number }>;

import { collections } from "../firebase/collections";

export function validateReading({
  inputTime,
  inputPages,
  previousPage,
  pageCount,
}) {
  const time = Number.parseInt(inputTime);
  const pages = Number.parseInt(inputPages);

  if (!inputTime || inputTime.length < 1) {
    return {
      valid: false,
      message: "Time read was empty",
    };
  } else if (!inputPages || inputPages.length < 1) {
    return {
      valid: false,
      message: "Current page was empty",
    };
  } else if (Object.is(pages, "NaN")) {
    return {
      valid: false,
      message: "Page number added is not a valid integer",
    };
  } else if (Object.is(time, "NaN")) {
    return {
      valid: false,
      message: "Number of minutes spent reading is not a valid integer",
    };
  } else if (pages < previousPage) {
    return {
      valid: false,
      message:
        "You can't read backwards. If you have to adjust the current page press the current page on the book card.",
    };
  } else if (pageCount < pages) {
    return {
      valid: false,
      message: "You can't read more pages than there are in the book.",
    };
  }
  // If none of the cases above kicks in the input is regarded as valid
  return {
    valid: true,
  };
}

export function validateCurrentPage({ inputPages, pageCount }) {
  const page = Number.parseInt(inputPages);
  if (!inputPages || inputPages.length < 1) {
    return {
      valid: false,
      message:
        "Page number is empty, and I don't like that one bit – no, sir, I don't.",
    };
  } else if (Object.is(page, NaN)) {
    return {
      valid: false,
      message: "Page number is not a valid number.",
    };
  } else if (page < 0 || pageCount < page) {
    return {
      valid: false,
      message:
        "Page number must be between 0 and the total number of pages in the book.",
    };
  }
  return {
    valid: true,
  };
}

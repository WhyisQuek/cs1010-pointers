void change_number(int *number) {
    *number = 20;
}

void change_element(int *element) {
    *element = 30;
}

void change_both(int *number, int *element) {
    change_number(number);
    change_element(element);
}

int main(void) {
    int number = 10;
    int values[3] = {1, 2, 3};
    change_number(&number);
    change_element(&values[1]);
    change_both(&number, &values[2]);
    return 0;
}

